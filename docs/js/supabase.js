// Configuração do cliente Supabase
// As chaves anon (públicas) ficam aqui — RLS protege os dados
const SUPABASE_URL = 'https://zbhllgizwdyiioeazxbm.supabase.co'
const SUPABASE_ANON_KEY = 'sb_publishable_82ASaW2O_zgahco8HWp6rA_fJbyjFLf'

const { createClient } = supabase
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
})
