-- ====================================================================
-- MartFlow AI: Multi-Tenant Production PostgreSQL Schema
-- Migration 001: Initial Schema with Row Level Security (RLS)
-- ====================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Organizations (Tenants)
CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    industry VARCHAR(100) DEFAULT 'Machinery & Manufacturing',
    plan VARCHAR(50) DEFAULT 'starter' CHECK (plan IN ('starter', 'growth', 'enterprise')),
    monthly_lead_limit INTEGER DEFAULT 500,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Profiles (App Users)
CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255),
    full_name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    is_email_verified BOOLEAN DEFAULT FALSE,
    is_phone_verified BOOLEAN DEFAULT FALSE,
    avatar_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Organization Memberships (RBAC)
CREATE TABLE IF NOT EXISTS organization_members (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL CHECK (role IN ('owner', 'admin', 'sales_manager', 'sales_agent')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(organization_id, user_id)
);

-- 4. Team Invitations
CREATE TABLE IF NOT EXISTS invitations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL CHECK (role IN ('admin', 'sales_manager', 'sales_agent')),
    token VARCHAR(255) UNIQUE NOT NULL,
    invited_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
    status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Integration Connections
CREATE TABLE IF NOT EXISTS integration_connections (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL CHECK (provider IN ('whatsapp_cloud', 'whatsapp_baileys', 'indiamart', 'gemini', 'razorpay')),
    status VARCHAR(50) DEFAULT 'disconnected' CHECK (status IN ('connected', 'disconnected', 'pending', 'error')),
    credentials_encrypted JSONB DEFAULT '{}',
    webhook_secret VARCHAR(255),
    phone_number VARCHAR(50),
    waba_id VARCHAR(100),
    last_event_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(organization_id, provider)
);

-- 6. Catalog Files
CREATE TABLE IF NOT EXISTS catalog_files (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,
    file_type VARCHAR(50) NOT NULL,
    file_size_bytes BIGINT NOT NULL,
    storage_path TEXT NOT NULL,
    extracted_text TEXT,
    products_count INTEGER DEFAULT 0,
    processing_status VARCHAR(50) DEFAULT 'processing' CHECK (processing_status IN ('processing', 'processed', 'failed')),
    error_message TEXT,
    uploaded_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Structured Products
CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    catalog_file_id UUID REFERENCES catalog_files(id) ON DELETE SET NULL,
    name VARCHAR(255) NOT NULL,
    sku VARCHAR(100),
    category VARCHAR(100),
    model VARCHAR(100),
    description TEXT,
    price_min NUMERIC(14, 2),
    price_max NUMERIC(14, 2),
    price_raw VARCHAR(255),
    currency VARCHAR(10) DEFAULT 'INR',
    minimum_order_quantity INTEGER DEFAULT 1,
    capacity VARCHAR(100),
    specifications JSONB DEFAULT '{}',
    applications TEXT[] DEFAULT '{}',
    keywords TEXT[] DEFAULT '{}',
    brochure_filename VARCHAR(255),
    confidence_score NUMERIC(3, 2) DEFAULT 1.0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. Leads
CREATE TABLE IF NOT EXISTS leads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    source_event_id VARCHAR(255),
    source VARCHAR(100) DEFAULT 'IndiaMART',
    buyer_name VARCHAR(255),
    buyer_phone VARCHAR(50) NOT NULL,
    buyer_city VARCHAR(100),
    product_inquired VARCHAR(255),
    matched_product_id UUID REFERENCES products(id) ON DELETE SET NULL,
    requirement TEXT,
    pdf_brochure_sent BOOLEAN DEFAULT FALSE,
    pdf_sent_at TIMESTAMPTZ,
    status VARCHAR(50) DEFAULT 'new' CHECK (status IN ('new', 'processing', 'replied', 'qualified', 'awaiting_call', 'call_booked', 'converted', 'lost', 'failed')),
    first_response_ms INTEGER,
    assigned_to UUID REFERENCES profiles(id) ON DELETE SET NULL,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(organization_id, source_event_id)
);

-- 9. Conversations & Messages
CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    lead_id UUID UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
    channel VARCHAR(50) DEFAULT 'whatsapp',
    mode VARCHAR(20) DEFAULT 'ai' CHECK (mode IN ('ai', 'human')),
    is_unread BOOLEAN DEFAULT FALSE,
    last_message_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_type VARCHAR(20) NOT NULL CHECK (sender_type IN ('buyer', 'ai', 'agent', 'system')),
    sender_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
    content TEXT NOT NULL,
    media_url TEXT,
    media_type VARCHAR(50),
    delivery_status VARCHAR(50) DEFAULT 'sent' CHECK (delivery_status IN ('queued', 'sent', 'delivered', 'read', 'failed')),
    provider_message_id VARCHAR(255),
    failure_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 10. Call Requests (2-Way Call Booking Engine)
CREATE TABLE IF NOT EXISTS call_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    requested_by VARCHAR(50) DEFAULT 'buyer',
    owner_phone VARCHAR(50) NOT NULL,
    status VARCHAR(50) DEFAULT 'requested' CHECK (status IN ('requested', 'awaiting_owner', 'proposed', 'confirmed', 'completed', 'cancelled', 'reschedule_requested')),
    proposed_time_raw VARCHAR(255),
    confirmed_time TIMESTAMPTZ,
    confirmed_by VARCHAR(50),
    lead_dossier_sent BOOLEAN DEFAULT FALSE,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 11. AI Settings
CREATE TABLE IF NOT EXISTS ai_settings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID UNIQUE NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    is_enabled BOOLEAN DEFAULT TRUE,
    company_name VARCHAR(255) NOT NULL,
    city_base VARCHAR(255) DEFAULT 'Delhi NCR',
    custom_greeting TEXT,
    supported_languages TEXT[] DEFAULT ARRAY['Hinglish', 'Hindi', 'English'],
    reply_delay_sec INTEGER DEFAULT 5,
    send_voice_notes BOOLEAN DEFAULT TRUE,
    confidence_threshold NUMERIC(3, 2) DEFAULT 0.70,
    strict_catalog_only BOOLEAN DEFAULT TRUE,
    escalation_phone VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 12. Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(100) NOT NULL,
    resource_id VARCHAR(255),
    metadata JSONB DEFAULT '{}',
    ip_address VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for lightning fast multi-tenant queries
CREATE INDEX IF NOT EXISTS idx_members_org ON organization_members(organization_id);
CREATE INDEX IF NOT EXISTS idx_members_user ON organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_leads_org ON leads(organization_id);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(buyer_phone);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_products_org ON products(organization_id);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_calls_org ON call_requests(organization_id);

-- Enable Row Level Security (RLS) on all tenant tables
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

