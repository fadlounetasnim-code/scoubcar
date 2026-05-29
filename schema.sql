-- =========================================================================
-- International Cargo & Shipping Agency - Supabase Database Schema
-- Morocco to Europe Parcel Delivery System (Production Ready)
-- =========================================================================

-- Enable pgcrypto extension for secure crypt utilities
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. DROP EXISTING TRIGGERS ON EXTERNAL TABLES (auth.users)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

-- 2. DROP TABLES IN CASCADE ORDER (to resolve foreign key dependencies)
DROP TABLE IF EXISTS public.settings CASCADE;
DROP TABLE IF EXISTS public.country_prices CASCADE;
DROP TABLE IF EXISTS public.invoices CASCADE;
DROP TABLE IF EXISTS public.shipments CASCADE;
DROP TABLE IF EXISTS public.customers CASCADE;
DROP TABLE IF EXISTS public.users CASCADE;

-- 3. CREATE TABLES IN LOGICAL ORDER

-- A. Public Users (Profiles) Table
CREATE TABLE public.users (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('Admin', 'Employee')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- B. Customers Table
CREATE TABLE public.customers (
    id TEXT PRIMARY KEY, -- CUST-XXXX
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT,
    address TEXT,
    morocco_id TEXT NOT NULL, -- CIN or Passport Number
    shipments_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- C. Shipments Table
CREATE TABLE public.shipments (
    tracking_number TEXT PRIMARY KEY, -- MA-EU-XXXXXX
    sender_name TEXT NOT NULL,
    sender_phone TEXT NOT NULL,
    sender_customer_id TEXT NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
    receiver_name TEXT NOT NULL,
    receiver_phone TEXT NOT NULL,
    destination_country TEXT NOT NULL, -- FR, ES, etc.
    city TEXT NOT NULL,
    full_address TEXT NOT NULL,
    weight NUMERIC(10, 2) NOT NULL CHECK (weight > 0),
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
    shipping_price NUMERIC(10, 2) NOT NULL CHECK (shipping_price >= 0),
    status TEXT NOT NULL CHECK (status IN ('received', 'processing', 'transit', 'arrived', 'delivered', 'cancelled')) DEFAULT 'received',
    notes TEXT,
    status_history JSONB NOT NULL DEFAULT '[]'::jsonb,
    employee_id UUID REFERENCES public.users(id) ON DELETE SET NULL, -- Track which agent created it
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- D. Invoices Table
CREATE TABLE public.invoices (
    invoice_number TEXT PRIMARY KEY, -- FAC-YYYYMMDD-XXXX
    shipment_tracking_number TEXT NOT NULL REFERENCES public.shipments(tracking_number) ON DELETE CASCADE,
    customer_id TEXT NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
    customer_name TEXT NOT NULL,
    total_amount NUMERIC(10, 2) NOT NULL CHECK (total_amount >= 0),
    payment_status TEXT NOT NULL CHECK (payment_status IN ('unpaid', 'paid', 'refunded')) DEFAULT 'paid',
    payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'bank_transfer', 'card')) DEFAULT 'cash',
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- E. Country Prices Table
CREATE TABLE public.country_prices (
    country_code TEXT PRIMARY KEY, -- FR, ES, DE, etc.
    country_name TEXT NOT NULL,
    flag TEXT NOT NULL,
    price_per_kg NUMERIC(10, 2) NOT NULL CHECK (price_per_kg >= 0),
    base_price NUMERIC(10, 2) NOT NULL CHECK (base_price >= 0),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- F. Settings Table
CREATE TABLE public.settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);


-- =========================================================================
-- DATABASE TRIGGERS & FUNCTIONS DEFINITIONS
-- =========================================================================

-- A. Auto Sync Auth User to Public Profiles Trigger Function
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.users (id, email, name, role)
  VALUES (
    new.id,
    new.email,
    COALESCE(new.raw_user_meta_data->>'name', 'مستخدم جديد'),
    COALESCE(new.raw_user_meta_data->>'role', 'Employee')
  );
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- B. Auto Update Customer Shipments Count Trigger Function
CREATE OR REPLACE FUNCTION public.update_customer_shipments_count()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.customers 
    SET shipments_count = shipments_count + 1 
    WHERE id = NEW.sender_customer_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.customers 
    SET shipments_count = shipments_count - 1 
    WHERE id = OLD.sender_customer_id;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.sender_customer_id IS DISTINCT FROM NEW.sender_customer_id THEN
      UPDATE public.customers 
      SET shipments_count = shipments_count - 1 
      WHERE id = OLD.sender_customer_id;
      UPDATE public.customers 
      SET shipments_count = shipments_count + 1 
      WHERE id = NEW.sender_customer_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- =========================================================================
-- ATTACH TRIGGERS TO TABLES
-- =========================================================================

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE TRIGGER on_shipment_changed
  AFTER INSERT OR UPDATE OR DELETE ON public.shipments
  FOR EACH ROW EXECUTE FUNCTION public.update_customer_shipments_count();


-- =========================================================================
-- ROLE-BASED ACCESS CHECKS & HELPER FUNCTIONS
-- =========================================================================

-- Avoid infinite recursion in RLS policies by writing a SECURITY DEFINER role fetcher.
CREATE OR REPLACE FUNCTION public.get_user_role(user_id UUID)
RETURNS text AS $$
DECLARE
  u_role text;
BEGIN
  SELECT role INTO u_role FROM public.users WHERE id = user_id;
  RETURN u_role;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean AS $$
BEGIN
  RETURN public.get_user_role(auth.uid()) = 'Admin';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.is_employee()
RETURNS boolean AS $$
BEGIN
  RETURN public.get_user_role(auth.uid()) = 'Employee';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- RPC Function to delete a user from auth.users (Callable by Admins only)
CREATE OR REPLACE FUNCTION public.delete_user_by_admin(user_id UUID)
RETURNS void AS $$
BEGIN
  IF public.is_admin() THEN
    DELETE FROM auth.users WHERE id = user_id;
  ELSE
    RAISE EXCEPTION 'غير مصرح للقيام بهذه العملية. الصلاحية للمسؤولين فقط.';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- =========================================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- =========================================================================

-- A. Enable RLS on all tables
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.country_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

-- B. Drop existing policies to prevent conflicts during re-runs
DROP POLICY IF EXISTS select_users ON public.users;
DROP POLICY IF EXISTS update_users ON public.users;
DROP POLICY IF EXISTS delete_users ON public.users;

DROP POLICY IF EXISTS select_customers ON public.customers;
DROP POLICY IF EXISTS insert_customers ON public.customers;
DROP POLICY IF EXISTS update_customers ON public.customers;
DROP POLICY IF EXISTS delete_customers ON public.customers;

DROP POLICY IF EXISTS select_shipments ON public.shipments;
DROP POLICY IF EXISTS insert_shipments ON public.shipments;
DROP POLICY IF EXISTS update_shipments ON public.shipments;
DROP POLICY IF EXISTS delete_shipments ON public.shipments;

DROP POLICY IF EXISTS select_invoices ON public.invoices;
DROP POLICY IF EXISTS insert_invoices ON public.invoices;
DROP POLICY IF EXISTS update_invoices ON public.invoices;
DROP POLICY IF EXISTS delete_invoices ON public.invoices;

DROP POLICY IF EXISTS select_prices ON public.country_prices;
DROP POLICY IF EXISTS insert_prices ON public.country_prices;
DROP POLICY IF EXISTS update_prices ON public.country_prices;
DROP POLICY IF EXISTS delete_prices ON public.country_prices;

DROP POLICY IF EXISTS select_settings ON public.settings;
DROP POLICY IF EXISTS insert_settings ON public.settings;
DROP POLICY IF EXISTS update_settings ON public.settings;
DROP POLICY IF EXISTS delete_settings ON public.settings;

-- C. Create policies

-- 1. Users policies
CREATE POLICY select_users ON public.users
    FOR SELECT TO authenticated USING (true);
CREATE POLICY update_users ON public.users
    FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY delete_users ON public.users
    FOR DELETE TO authenticated USING (public.is_admin());

-- 2. Customers policies
CREATE POLICY select_customers ON public.customers
    FOR SELECT TO authenticated USING (true);
CREATE POLICY insert_customers ON public.customers
    FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY update_customers ON public.customers
    FOR UPDATE TO authenticated USING (true);
CREATE POLICY delete_customers ON public.customers
    FOR DELETE TO authenticated USING (public.is_admin());

-- 3. Shipments policies
CREATE POLICY select_shipments ON public.shipments
    FOR SELECT TO authenticated USING (true);
CREATE POLICY insert_shipments ON public.shipments
    FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY update_shipments ON public.shipments
    FOR UPDATE TO authenticated USING (public.is_admin() OR (public.is_employee() AND employee_id = auth.uid()));
CREATE POLICY delete_shipments ON public.shipments
    FOR DELETE TO authenticated USING (public.is_admin());

-- 4. Invoices policies
CREATE POLICY select_invoices ON public.invoices
    FOR SELECT TO authenticated USING (true);
CREATE POLICY insert_invoices ON public.invoices
    FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY update_invoices ON public.invoices
    FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY delete_invoices ON public.invoices
    FOR DELETE TO authenticated USING (public.is_admin());

-- 5. Country Prices policies
CREATE POLICY select_prices ON public.country_prices
    FOR SELECT TO authenticated USING (true);
CREATE POLICY insert_prices ON public.country_prices
    FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY update_prices ON public.country_prices
    FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY delete_prices ON public.country_prices
    FOR DELETE TO authenticated USING (public.is_admin());

-- 6. Settings policies
CREATE POLICY select_settings ON public.settings
    FOR SELECT USING (true); -- Allow all to read settings (including system name before login)
CREATE POLICY insert_settings ON public.settings
    FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY update_settings ON public.settings
    FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY delete_settings ON public.settings
    FOR DELETE TO authenticated USING (public.is_admin());


-- =========================================================================
-- SEED DATA
-- =========================================================================

-- A. Seed Settings
INSERT INTO public.settings (key, value) VALUES
('system_name', 'أطلس إكسبريس')
ON CONFLICT (key) DO NOTHING;

-- B. Seed European Country Prices
INSERT INTO public.country_prices (country_code, country_name, flag, price_per_kg, base_price, is_active) VALUES
('FR', 'فرنسا', '🇫🇷', 25.00, 50.00, true),
('ES', 'إسبانيا', '🇪🇸', 20.00, 40.00, true),
('IT', 'إيطاليا', '🇮🇹', 30.00, 60.00, true),
('DE', 'ألمانيا', '🇩🇪', 30.00, 60.00, true),
('BE', 'بلجيكا', '🇧🇪', 28.00, 50.00, true),
('NL', 'هولندا', '🇳🇱', 28.00, 50.00, true),
('GB', 'المملكة المتحدة', '🇬🇧', 40.00, 80.00, true),
('PT', 'البرتغال', '🇵🇹', 22.00, 45.00, true),
('CH', 'سويسرا', '🇨🇭', 35.00, 70.00, true),
('SE', 'السويد', '🇸🇪', 45.00, 90.00, true),
('NO', 'النرويج', '🇳🇴', 50.00, 100.00, true),
('DK', 'الدنمارك', '🇩🇰', 40.00, 80.00, true),
('FI', 'فنلندا', '🇫🇮', 45.00, 90.00, true),
('IE', 'أيرلندا', '🇮🇪', 38.00, 75.00, true),
('AT', 'النمسا', '🇦🇹', 32.00, 65.00, true),
('PL', 'بولندا', '🇵🇱', 35.00, 70.00, true),
('TR', 'تركيا', '🇹🇷', 35.00, 70.00, true),
('GR', 'اليونان', '🇬🇷', 38.00, 75.00, true),
('RO', 'رومانيا', '🇷🇴', 35.00, 70.00, true),
('CZ', 'التشيك', '🇨🇿', 35.00, 70.00, true),
('HU', 'المجر', '🇭🇺', 38.00, 75.00, true),
('BG', 'بلغاريا', '🇧🇬', 40.00, 80.00, true),
('HR', 'كرواتيا', '🇭🇷', 38.00, 75.00, true),
('LT', 'ليتوانيا', '🇱🇹', 40.00, 80.00, true),
('LV', 'لاتفيا', '🇱🇻', 40.00, 80.00, true),
('EE', 'إستونيا', '🇪🇪', 42.00, 85.00, true),
('SK', 'سلوفاكيا', '🇸🇰', 36.00, 72.00, true),
('SI', 'سلوفينيا', '🇸🇮', 36.00, 72.00, true),
('LU', 'لوكسمبورغ', '🇱🇺', 28.00, 55.00, true),
('CY', 'قبرص', '🇨🇾', 45.00, 90.00, true),
('MT', 'مالطا', '🇲🇹', 45.00, 90.00, true),
('AL', 'ألبانيا', '🇦🇱', 40.00, 80.00, true),
('AD', 'أندورا', '🇦🇩', 25.00, 50.00, true),
('BA', 'البوسنة والهرسك', '🇧🇦', 40.00, 80.00, true),
('IS', 'أيسلندا', '🇮🇸', 50.00, 100.00, true),
('XK', 'كوسوفو', '🇽🇰', 40.00, 80.00, true),
('LI', 'ليختنشتاين', '🇱🇮', 35.00, 70.00, true),
('MK', 'مقدونيا الشمالية', '🇲🇰', 40.00, 80.00, true),
('MC', 'موناكو', '🇲🇨', 25.00, 50.00, true),
('ME', 'الجبل الأسود', '🇲🇪', 40.00, 80.00, true),
('SM', 'سان مارينو', '🇸🇲', 30.00, 60.00, true),
('RS', 'صربيا', '🇷🇸', 40.00, 80.00, true),
('UA', 'أوكرانيا', '🇺🇦', 45.00, 90.00, true),
('BY', 'بيلاروسيا', '🇧🇾', 45.00, 90.00, true)
ON CONFLICT (country_code) DO UPDATE
SET country_name = EXCLUDED.country_name,
    flag = EXCLUDED.flag,
    price_per_kg = EXCLUDED.price_per_kg,
    base_price = EXCLUDED.base_price;


-- C. Seed Default Admin User in auth.users (email: admin@atlas.com, password: admin1234)
INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, 
    email_confirmed_at, recovery_sent_at, last_sign_in_at, 
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at, 
    confirmation_token, email_change, email_change_token_new, recovery_token
)
VALUES (
    '00000000-0000-0000-0000-000000000000',
    'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d', -- Static UUID for the seeded Admin account
    'authenticated',
    'authenticated',
    'admin@atlas.com',
    crypt('admin1234', gen_salt('bf', 10)), -- Password: admin1234
    now(),
    NULL,
    NULL,
    '{"provider":"email","providers":["email"]}',
    '{"name":"مدير الوكالة","role":"Admin"}',
    now(),
    now(),
    '',
    '',
    '',
    ''
) ON CONFLICT (id) DO NOTHING;

-- Enable real-time replication for all public tables
BEGIN;
  DROP PUBLICATION IF EXISTS supabase_realtime;
  CREATE PUBLICATION supabase_realtime FOR ALL TABLES;
COMMIT;
