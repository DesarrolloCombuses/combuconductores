-- Comprobante de asistencia por WhatsApp via Pabbly Connect + WATI.
--
-- Flujo (server-side, "dispara y olvida"):
--   INSERT en asistencias  ->  trigger notificar_comprobante_whatsapp()
--     -> si el usuario digito un celular en la marca, hace net.http_post
--        al webhook de Pabbly Connect (URL guardada en Vault)
--          -> Pabbly formatea y llama a WATI
--            -> WATI envia el WhatsApp al colaborador
--
-- IMPORTANTE: el envio NO ocurre hasta que se cree el secreto de Vault con la
-- URL real del webhook de Pabbly (ver el bloque comentado al final). Mientras
-- ese secreto no exista, el trigger simplemente no hace nada (no rompe la marca).

-- 1) Columna opcional: numero que el conductor digita si quiere el comprobante.
alter table public.asistencias
  add column if not exists celular_comprobante text;

-- 2) Funcion del trigger.
create or replace function public.notificar_comprobante_whatsapp()
returns trigger
language plpgsql
security definer
set search_path = public, vault, extensions
as $function$
declare
  v_url         text;
  v_nombre      text;
  v_dni         text;
  v_celular     text;
  v_coordenadas text;
  v_mapa_url    text;
  v_payload     jsonb;
begin
  -- Solo si el usuario pidio comprobante (digito un celular con largo razonable).
  if new.celular_comprobante is null
     or length(regexp_replace(new.celular_comprobante, '[^0-9]', '', 'g')) < 7 then
    return new;
  end if;

  -- URL del webhook de Pabbly (guardada en Vault). Si no existe, no enviamos.
  select decrypted_secret
    into v_url
  from vault.decrypted_secrets
  where name = 'pabbly_webhook_comprobante'
  limit 1;

  if v_url is null then
    return new;
  end if;

  -- Datos del colaborador para el mensaje.
  select nombre, dni
    into v_nombre, v_dni
  from public.colaboradores
  where id = new.colaborador_id;

  -- Normaliza el celular a formato internacional (Colombia +57 si son 10 digitos).
  v_celular := regexp_replace(new.celular_comprobante, '[^0-9]', '', 'g');
  if length(v_celular) = 10 then
    v_celular := '57' || v_celular;
  end if;
  v_celular := '+' || v_celular;

  -- Coordenadas y link de Google Maps ya armados (dominio de confianza, sin
  -- acortadores: Meta no penaliza google.com). Vacio si no hay ubicacion.
  if new.latitud is not null and new.longitud is not null then
    v_coordenadas := new.latitud::text || ',' || new.longitud::text;
    v_mapa_url := 'https://maps.google.com/?q=' || v_coordenadas;
  else
    v_coordenadas := '';
    v_mapa_url := '';
  end if;

  v_payload := jsonb_build_object(
    'celular',         v_celular,
    'nombre',          coalesce(v_nombre, 'Colaborador'),
    'cedula',          coalesce(v_dni, ''),
    'tipo',            new.sentido,
    'fecha',           new.fecha::text,
    'hora',            new.hora::text,
    'jornada',         new.jornada::text,
    'latitud',         new.latitud,
    'longitud',        new.longitud,
    'coordenadas',     v_coordenadas,
    'mapa_url',        v_mapa_url,
    'punto_operativo', coalesce(new.punto_operativo, ''),
    'enviado_buk',     coalesce(new.enviado_buk, false),
    'asistencia_id',   new.id
  );

  -- Envio asincrono: pg_net encola el POST y NO bloquea el INSERT de la marca.
  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := v_payload
  );

  return new;
end;
$function$;

-- 3) Trigger AFTER INSERT (la fila ya existe y tiene id).
drop trigger if exists trg_notificar_comprobante on public.asistencias;
create trigger trg_notificar_comprobante
after insert on public.asistencias
for each row
execute function public.notificar_comprobante_whatsapp();

-- 4) PASO MANUAL (hazlo cuando tengas la URL del webhook de Pabbly):
--    Reemplaza la URL de ejemplo por la real y ejecuta:
--
-- select vault.create_secret(
--   'https://connect.pabbly.com/workflow/sendwebhookdata/XXXXXXXX',
--   'pabbly_webhook_comprobante',
--   'Webhook de Pabbly Connect para el comprobante de asistencia por WhatsApp (WATI)'
-- );
--
--    Para actualizarla despues:
-- update vault.secrets
--    set secret = 'https://connect.pabbly.com/workflow/sendwebhookdata/NUEVA'
--  where name = 'pabbly_webhook_comprobante';
