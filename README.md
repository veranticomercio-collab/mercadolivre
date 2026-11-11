# Pearland ERP

Dashboard responsivo de vendas, notas fiscais e etiquetas do Mercado Livre.

## Desenvolvimento

`npm install` e `npm run dev`. Configure `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` no arquivo `.env` (veja `.env.example`).

## Segurança

A API `pearland-dashboard-api` exige login Supabase e cadastro do usuário em `pearland_dashboard_users`. Nunca coloque service-role ou tokens Mercado Livre no frontend. A aplicação não altera pedidos, NF-e ou impressão.

## Publicação

Aplicação Vite/React: build `npm run build`, diretório `dist`. Configure variáveis públicas do Supabase na hospedagem. O deploy ainda precisa ser conectado a um provedor de hospedagem.
