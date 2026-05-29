// =========================================================================
// International Cargo & Shipping Agency - Supabase Browser Client
// =========================================================================

const supabaseUrl = "https://zwtzhmyrfnrwgswvsviw.supabase.co";
const supabaseKey = "sb_publishable_T0E-CM7Z6br0LWIkzh67Aw_ReQuEA3H";

const supabaseClient = window.supabase.createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true
  }
});

window.supabaseClient = supabaseClient;

console.log("Supabase Client Initialized");