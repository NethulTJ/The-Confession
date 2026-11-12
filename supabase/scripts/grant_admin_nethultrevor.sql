-- Run this in the Supabase SQL Editor for project gmobzdlgeqrfoogbxyvy.
-- Assigns the server-controlled app_metadata role used by the admin dashboard.
-- Existing app_metadata values are preserved.
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
  || jsonb_build_object('role', 'admin')
where lower(email) = lower('nethultrevor@gmail.com')
returning
  id,
  email,
  raw_app_meta_data ->> 'role' as assigned_role;
