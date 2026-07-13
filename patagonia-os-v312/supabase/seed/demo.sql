insert into public.companies (id, name)
values ('11111111-1111-1111-1111-111111111111', 'Carnes Patagonia')
on conflict do nothing;

insert into public.branches (id, company_id, name)
values
('22222222-2222-2222-2222-222222222221', '11111111-1111-1111-1111-111111111111', 'Haedo'),
('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Castelar')
on conflict do nothing;
