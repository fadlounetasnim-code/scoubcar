// =========================================================================
-- International Cargo & Shipping Agency - Supabase Browser Client
// =========================================================================

const supabaseUrl = "https://zwtzhmyrfnrwgswvsviw.supabase.co";
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp3dHpobXlyZm5yd2dzd3Zzdml3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAwMDIyOTIsImV4cCI6MjA5NTU3ODI5Mn0.w3jJfdx9VpsRyEA-D8K-m8fhfeoiUQEI9nHgZP0onn4";

// supabase.createClient is provided by the @supabase/supabase-js library loaded from CDN.
const supabaseClient = supabase.createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true
  }
});

// Bind to window for global access in app.js
window.supabase = supabaseClient;
window.supabaseUrl = supabaseUrl;
window.supabaseKey = supabaseKey;

console.log("Supabase Client Initialized and bound to window.supabase");
