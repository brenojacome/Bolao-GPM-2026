// Configuração do cliente Supabase
// As chaves anon (públicas) ficam aqui — RLS protege os dados
const SUPABASE_URL = 'PLACEHOLDER_SUPABASE_URL'
const SUPABASE_ANON_KEY = 'PLACEHOLDER_SUPABASE_ANON_KEY'

const { createClient } = supabase
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
})
