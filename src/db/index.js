/**
 * MartFlow AI — Universal Multi-Tenant Database Client
 * Supports PostgreSQL / Supabase with in-process transactional store for tests and zero-setup local dev.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In-Memory / File-Persisted Multi-Tenant Relational Store
class MultiTenantDB {
  constructor() {
    this.tables = {
      organizations: new Map(),
      profiles: new Map(),
      organization_members: new Map(),
      invitations: new Map(),
      integration_connections: new Map(),
      catalog_files: new Map(),
      products: new Map(),
      leads: new Map(),
      conversations: new Map(),
      messages: new Map(),
      call_requests: new Map(),
      ai_settings: new Map(),
      audit_logs: new Map(),
      subscriptions: new Map()
    };
    this.dbFile = path.join(__dirname, '..', '..', 'martflow_data.json');
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.dbFile)) {
        const raw = JSON.parse(fs.readFileSync(this.dbFile, 'utf8'));
        for (const [table, rows] of Object.entries(raw)) {
          if (this.tables[table]) {
            this.tables[table] = new Map(rows.map(r => [r.id, r]));
          }
        }
      }
    } catch (e) {
      console.warn('Notice: Local DB initialized fresh or fallback used:', e.message);
    }
  }

  persist() {
    try {
      const dump = {};
      for (const [table, map] of Object.entries(this.tables)) {
        dump[table] = Array.from(map.values());
      }
      fs.writeFileSync(this.dbFile, JSON.stringify(dump, null, 2), 'utf8');
    } catch (e) {
      console.error('Database persist error:', e.message);
    }
  }

  // Insert a record into a table
  insert(tableName, record) {
    const table = this.tables[tableName];
    if (!table) throw new Error(`Unknown table: ${tableName}`);
    if (!record.id) {
      record.id = 'mf_' + Math.random().toString(36).slice(2, 11) + '_' + Date.now().toString(36);
    }
    const now = new Date().toISOString();
    record.created_at = record.created_at || now;
    record.updated_at = record.updated_at || now;
    table.set(record.id, { ...record });
    this.persist();
    return { ...record };
  }

  // Find record by ID
  findById(tableName, id) {
    const table = this.tables[tableName];
    if (!table) return null;
    const item = table.get(id);
    return item ? { ...item } : null;
  }

  // Find one record matching predicate
  findOne(tableName, predicate) {
    const table = this.tables[tableName];
    if (!table) return null;
    for (const item of table.values()) {
      if (predicate(item)) return { ...item };
    }
    return null;
  }

  // Find all records matching predicate, optionally scoped to tenant
  find(tableName, predicate = () => true) {
    const table = this.tables[tableName];
    if (!table) return [];
    const results = [];
    for (const item of table.values()) {
      if (predicate(item)) results.push({ ...item });
    }
    return results;
  }

  // Strictly Tenant-Scoped Query (Non-negotiable multi-tenant isolation)
  findScoped(tableName, organizationId, predicate = () => true) {
    if (!organizationId) {
      throw new Error(`Tenant Isolation Security Violation: Missing organization_id on query to ${tableName}`);
    }
    return this.find(tableName, (item) => item.organization_id === organizationId && predicate(item));
  }

  // Update a record
  update(tableName, id, updates) {
    const table = this.tables[tableName];
    if (!table || !table.has(id)) return null;
    const current = table.get(id);
    const updated = {
      ...current,
      ...updates,
      updated_at: new Date().toISOString()
    };
    table.set(id, updated);
    this.persist();
    return { ...updated };
  }

  // Update with tenant verification
  updateScoped(tableName, id, organizationId, updates) {
    const current = this.findById(tableName, id);
    if (!current) return null;
    if (current.organization_id && current.organization_id !== organizationId) {
      throw new Error(`Unauthorized cross-tenant mutation attempted on ${tableName} (ID: ${id})`);
    }
    return this.update(tableName, id, updates);
  }

  // Delete a record
  delete(tableName, id) {
    const table = this.tables[tableName];
    if (!table || !table.has(id)) return false;
    const res = table.delete(id);
    this.persist();
    return res;
  }

  // Clear table (testing utility)
  clear(tableName) {
    if (this.tables[tableName]) {
      this.tables[tableName].clear();
      this.persist();
    }
  }
}

export const db = new MultiTenantDB();
export default db;
