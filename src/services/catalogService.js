/**
 * MartFlow AI — Universal Catalog & Product Extraction Service
 * Ingests PDF, XLSX, XLS, and CSV files into structured, tenant-isolated product records.
 */

import fs from 'fs';
import path from 'path';
import stream from 'stream';
import { createRequire } from 'module';
import ExcelJS from 'exceljs';
import db from '../db/index.js';
import { invalidateCache } from './aiService.js';

const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');

export class CatalogService {
  // Ingest a catalog file (PDF, XLSX, CSV)
  static async ingestCatalog(organizationId, { filename, buffer, uploadedBy = null }) {
    if (!organizationId) throw new Error('organization_id is required');
    if (!/^[a-zA-Z0-9_-]{8,64}$/.test(organizationId)) {
      throw new Error('Invalid organization ID: must be safe alphanumeric identifier (8-64 characters)');
    }
    if (!filename || !buffer) throw new Error('filename and buffer are required');

    const ext = path.extname(filename).toLowerCase();
    if (ext === '.xls') {
      throw new Error('Legacy .xls (Excel 97-2003) format is unsupported for security compliance. Please upload .xlsx or .csv.');
    }

    const safeFilename = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const baseCatalogsDir = path.resolve(process.cwd(), 'catalogs');
    const storageDir = path.resolve(baseCatalogsDir, organizationId);
    if (!storageDir.startsWith(baseCatalogsDir + path.sep)) {
      throw new Error('Tenant storage path traversal detected');
    }
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }
    const storagePath = path.resolve(storageDir, safeFilename);
    if (!storagePath.startsWith(storageDir + path.sep)) {
      throw new Error('Catalog filename path traversal detected');
    }
    if (fs.existsSync(storagePath)) {
      const stat = fs.lstatSync(storagePath);
      if (stat.isSymbolicLink()) {
        throw new Error('Symbolic links are forbidden in catalog storage');
      }
    }
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

      } else if (ext === '.xlsx' || ext === '.csv') {
        const wb = new ExcelJS.Workbook();
        if (ext === '.csv') {
          const pass = new stream.PassThrough();
          pass.end(buffer);
          await wb.csv.read(pass);
        } else {
          await wb.xlsx.load(buffer);
        }

        const textLines = [];
        for (const worksheet of wb.worksheets) {
          const sheetName = worksheet.name || 'Sheet1';
          const headerRow = worksheet.getRow(1);
          const headers = [];
          headerRow.eachCell((cell, colNumber) => {
            headers[colNumber] = String(cell.value || '').trim();
          });

          const rows = [];
          for (let rowNum = 2; rowNum <= worksheet.rowCount; rowNum++) {
            const row = worksheet.getRow(rowNum);
            const rowObj = {};
            let hasValue = false;
            row.eachCell((cell, colNumber) => {
              const key = headers[colNumber] || `col_${colNumber}`;
              const val = typeof cell.value === 'object' && cell.value !== null && cell.value.text ? cell.value.text : String(cell.value || '');
              rowObj[key] = val;
              if (val) hasValue = true;
            });
            if (hasValue) rows.push(rowObj);
          }

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

      invalidateCache(organizationId);

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
    const res = db.updateScoped('products', productId, organizationId, updates);
    invalidateCache(organizationId);
    return res;
  }

  // Delete product
  static deleteProduct(organizationId, productId) {
    const existing = db.findById('products', productId);
    if (!existing || existing.organization_id !== organizationId) {
      throw new Error('Product not found or unauthorized');
    }
    const res = db.delete('products', productId);
    invalidateCache(organizationId);
    return res;
  }
}

export default CatalogService;
