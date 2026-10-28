-- Run after you have created your own login (Authentication → Users → Add user).
-- Replace the email with the one you signed up with.
update public.profiles set role = 'admin', active = true
where email = 'ryanpettit85@gmail.com';
