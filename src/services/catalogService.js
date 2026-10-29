/**
 * MartFlow AI — Universal Catalog & Product Extraction Service
 * Ingests PDF, XLSX, XLS, and CSV files into structured, tenant-isolated product records.
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import db from '../db/index.js';

const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');
const XLSX = require('xlsx');

export class CatalogService {
  // Ingest a catalog file (PDF, XLSX, XLS, CSV)
  static async ingestCatalog(organizationId, { filename, buffer, uploadedBy = null }) {
    if (!organizationId) throw new Error('organization_id is required');
    if (!filename || !buffer) throw new Error('filename and buffer are required');

    const ext = path.extname(filename).toLowerCase();
    const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storageDir = path.join(process.cwd(), 'catalogs', organizationId);
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }
    const storagePath = path.join(storageDir, safeFilename);
    fs.writeFileSync(storagePath, buffer);

    // Create catalog file record
    const catalogFile = db.insert('catalog_files', {
      organization_id: organizationId,
      filename: safeFilename,
      file_type: ext.replace('.', ''),
      file_size_bytes: buffer.length,
      storage_path: storagePath,
      processing_status: 'processing',
      uploaded_by: uploadedBy
    });

    let extractedText = '';
    const createdProducts = [];

    try {
      if (ext === '.pdf') {
        const p = new pdf.PDFParse({ data: buffer });
        const textRes = await p.getText();
        extractedText = textRes.text || '';

        // Extract products from PDF sections or default product entity
        const prodName = safeFilename.replace(/\.pdf$/i, '').replace(/[-_]/g, ' ').trim();
        const kw = prodName.toLowerCase().split(/\s+/).filter((w) => w.length > 2);

        // Search for pricing patterns in PDF text (e.g., ₹1,50,000 or Rs. 150000)
        const priceMatch = extractedText.match(/(?:₹|Rs\.?|INR)\s*([0-9,]+(?:\.[0-9]+)?)/i);
        const priceRaw = priceMatch ? priceMatch[0] : 'Contact factory for official GST quotation';

        const product = db.insert('products', {
          organization_id: organizationId,
          catalog_file_id: catalogFile.id,
          name: prodName,
          sku: `SKU-${safeFilename.slice(0, 4).toUpperCase()}-${Date.now().toString().slice(-4)}`,
          category: 'Machinery Equipment',
          price_raw: priceRaw,
          keywords: kw,
          brochure_filename: safeFilename,
          specifications: {
            extractedSample: extractedText.slice(0, 300).replace(/\s+/g, ' ').trim()
          },
          confidence_score: 0.90
        });
        createdProducts.push(product);

      } else if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') {
        const wb = ext === '.csv'
          ? XLSX.read(buffer.toString('utf8'), { type: 'string', raw: true })
          : XLSX.read(buffer, { type: 'buffer' });
        const textLines = [];

        for (const sheetName of wb.SheetNames) {
          const sheet = wb.Sheets[sheetName];
          const rows = XLSX.utils.sheet_to_json(sheet);
          if (rows.length) {
            textLines.push(`=== Sheet: ${sheetName} ===`);
            for (const r of rows) {
              const rowStr = Object.entries(r).map(([k, v]) => `${k}: ${v}`).join(' | ');
              textLines.push(rowStr);

              const nameKey = Object.keys(r).find((k) => /name|item|product|title|model|description/i.test(k));
              const priceKey = Object.keys(r).find((k) => /price|rate|cost|mrp|amount/i.test(k));
              const specsKey = Object.keys(r).find((k) => /spec|detail|feature|capacity|size|speed/i.test(k));

              const itemTitle = String(r[nameKey] || '').trim();
              if (itemTitle && itemTitle.length > 2) {
                const itemPrice = priceKey && r[priceKey] ? String(r[priceKey]) : 'Contact factory for quote';
                const itemSpecs = specsKey && r[specsKey] ? String(r[specsKey]) : '';
                const kw = itemTitle.toLowerCase().split(/[\s,-]+/).filter((w) => w.length > 2);

                const product = db.insert('products', {
                  organization_id: organizationId,
                  catalog_file_id: catalogFile.id,
                  name: itemTitle,
                  sku: `SKU-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
                  category: 'Industrial Machinery',
                  price_raw: itemPrice,
                  keywords: kw,
                  brochure_filename: safeFilename,
                  specifications: {
                    details: itemSpecs || 'Factory standard configuration'
                  },
                  confidence_score: 0.95
                });
                createdProducts.push(product);
              }
            }
          }
        }
        extractedText = textLines.join('\n');
      } else {
        extractedText = buffer.toString('utf8');
      }

      // Mark catalog file processed
      db.updateScoped('catalog_files', catalogFile.id, organizationId, {
        processing_status: 'processed',
        extracted_text: extractedText.slice(0, 50000), // Cap for memory safety
        products_count: createdProducts.length
      });

      return {
        catalogFile: db.findById('catalog_files', catalogFile.id),
        productsCount: createdProducts.length,
        products: createdProducts
      };

    } catch (err) {
      db.updateScoped('catalog_files', catalogFile.id, organizationId, {
        processing_status: 'failed',
        error_message: err.message
      });
      throw err;
    }
  }

  // List organization products
  static listProducts(organizationId, { search = '', category = '' } = {}) {
    let products = db.findScoped('products', organizationId);
    if (search) {
      const q = search.toLowerCase().trim();
      products = products.filter((p) =>
        p.name.toLowerCase().includes(q) ||
        (p.sku && p.sku.toLowerCase().includes(q)) ||
        (p.price_raw && p.price_raw.toLowerCase().includes(q))
      );
    }
    if (category) {
      products = products.filter((p) => p.category && p.category.toLowerCase() === category.toLowerCase());
    }
    return products;
  }

  // Update product
  static updateProduct(organizationId, productId, updates) {
    return db.updateScoped('products', productId, organizationId, updates);
  }

  // Delete product
  static deleteProduct(organizationId, productId) {
    const existing = db.findById('products', productId);
    if (!existing || existing.organization_id !== organizationId) {
      throw new Error('Product not found or unauthorized');
    }
    return db.delete('products', productId);
  }
}

export default CatalogService;
