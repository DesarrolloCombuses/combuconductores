-- Purga automatica de fotos vencidas para ahorrar espacio en Storage.
-- Recorre las asistencias cuya foto ya vencio (foto_eliminar_en <= hoy), borra el
-- archivo del bucket via la API de Storage (borrar solo la fila NO libera espacio)
-- y limpia foto_path para no volver a procesarla.
--
-- Aplica a TODAS las fotos con vencimiento:
--   * fotos normales de asistencia (15 dias)
--   * selfies de "salida por incapacidad/ausencia" (25 dias)
--
-- La service_role key se lee desde Vault (secreto 'service_role_key'), nunca queda
-- en texto plano en el codigo. Se programa con pg_cron (ya instalado).

create or replace function public.purgar_fotos_vencidas(p_limit int default 500)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key    text;
  v_base   text := 'https://cbplebkmxrkaafqdhiyi.supabase.co/storage/v1/object/';
  v_bucket text := 'asistencia-fotos';
  r        record;
  v_count  int := 0;
begin
  select decrypted_secret into v_key
  from vault.decrypted_secrets
  where name = 'service_role_key'
  limit 1;

  if v_key is null then
    raise exception 'No hay service_role_key en Vault';
  end if;

  for r in
    select id, foto_path
    from public.asistencias
    where foto_path is not null
      and foto_eliminar_en is not null
      and foto_eliminar_en <= current_date
    order by foto_eliminar_en
    limit p_limit
    for update skip locked
  loop
    -- Borra el archivo del bucket (async, via pg_net).
    perform net.http_delete(
      url     := v_base || v_bucket || '/' || r.foto_path,
      headers := jsonb_build_object('Authorization', 'Bearer ' || v_key)
    );
    -- Quita la referencia para no reprocesar y para que la UI no muestre foto rota.
    update public.asistencias set foto_path = null where id = r.id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- Programa la purga: todos los dias a las 03:00 (hora del servidor).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'purgar-fotos-vencidas') then
    perform cron.unschedule('purgar-fotos-vencidas');
  end if;
end
$$;

select cron.schedule('purgar-fotos-vencidas', '0 3 * * *', 'select public.purgar_fotos_vencidas(2000);');
