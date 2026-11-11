-- Film of heavy sets from the laptop camera, one or more short files per set, listed in observations (source 'vision', metric 'clip').
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('video', 'video', false, 52428800, array['video/webm', 'video/mp4'])
on conflict (id) do nothing;

create policy "video read" on storage.objects for select to authenticated using (bucket_id = 'video');
create policy "video add" on storage.objects for insert to authenticated with check (bucket_id = 'video');
create policy "video replace" on storage.objects for update to authenticated using (bucket_id = 'video') with check (bucket_id = 'video');
create policy "video remove" on storage.objects for delete to authenticated using (bucket_id = 'video' and (select private.is_coach()));
