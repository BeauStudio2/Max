-- Recorded voice cues (ElevenLabs audio), shared by every signed-in browser so phrases are bought once.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('voice', 'voice', false, 1048576, array['audio/mpeg'])
on conflict (id) do nothing;

create policy "voice read" on storage.objects for select to authenticated using (bucket_id = 'voice');
create policy "voice add" on storage.objects for insert to authenticated with check (bucket_id = 'voice');
create policy "voice replace" on storage.objects for update to authenticated using (bucket_id = 'voice') with check (bucket_id = 'voice');
