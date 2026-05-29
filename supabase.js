const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = "https://zwtzhmyrfnrwgswvsviw.supabase.co";
const supabaseKey = "sb_publishable_T0E-CM7Z6br0LWIkzh67Aw_ReQuEA3H";

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;