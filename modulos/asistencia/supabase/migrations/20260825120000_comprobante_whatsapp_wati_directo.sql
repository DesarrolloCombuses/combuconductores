-- Comprobante de asistencia por WhatsApp: WATI directo, sin pasar por Pabbly.
--
-- Antes: INSERT asistencias -> trigger -> net.http_post a Pabbly -> Pabbly formatea
-- y llama a WATI -> WATI envia el WhatsApp (ver 20260709200000_comprobante_whatsapp_pabbly.sql).
--
-- Ahora: INSERT asistencias -> trigger -> net.http_post directo a la API de WATI
-- (sendTemplateMessage v2) -> WATI envia el WhatsApp. Un salto menos, sin depender
-- de Pabbly para este flujo.
--
-- Plantilla usada: "comprobar" (categoria Utility, WATI), cuerpo:
--   Hola {{1}}, tu marca de {{2}} quedo registrada correctamente.
--   Fecha: {{3}}  Hora: {{4}}  Documento: {{5}}
--
-- Credenciales en Vault (creadas manualmente, no van en el codigo):
--   wati_api_token     -> "Bearer <token>", cuenta gerencia@combuses.com.co
--   wati_api_base_url  -> "https://live-mt-server.wati.io/1011210"
--
-- Verificado con una llamada de prueba directa (numero invalido a proposito, sin
-- tocar la tabla asistencias): WATI acepto template_name/channel_number/parameters
-- con `name` = "1".."5" y devolvio result=true, error=null. Solo fallo la entrega
-- por ser un numero de prueba (isValidWhatsAppNumber=false), no por el formato del
-- payload. El channel_number real es 573160235197 (lo devuelve GET
-- /api/v2/whatsapp/phoneNumbers): el numero que se penso usar en un principio,
-- 573145382506, no es un canal de WATI y la API lo rechaza con
-- "Channel with phone number '...' not found."

-- 1) Columnas para poder ver el resultado del envio sin salir de la base.
alter table public.asistencias
  add column if not exists whatsapp_status text,
  add column if not exists whatsapp_respuesta jsonb,
  add column if not exists whatsapp_enviado_en timestamptz,
  add column if not exists whatsapp_request_id bigint;

create or replace function public.notificar_comprobante_whatsapp()
returns trigger
language plpgsql
security definer
set search_path = public, vault, extensions
as $function$
declare
  v_token       text;
  v_base_url    text;
  v_nombre      text;
  v_dni         text;
  v_celular     text;   -- para el query param whatsappNumber: solo digitos, sin '+'
  v_payload     jsonb;
  v_url         text;
  v_request_id  bigint;
begin
  -- Solo si el usuario pidio comprobante (digito un celular con largo razonable).
  if new.celular_comprobante is null
     or length(regexp_replace(new.celular_comprobante, '[^0-9]', '', 'g')) < 7 then
    return new;
  end if;

  -- Credenciales de WATI (Vault). Si falta alguna, no enviamos (no rompe la marca).
  select decrypted_secret into v_token
    from vault.decrypted_secrets where name = 'wati_api_token' limit 1;
  select decrypted_secret into v_base_url
    from vault.decrypted_secrets where name = 'wati_api_base_url' limit 1;

  if v_token is null or v_base_url is null then
    return new;
  end if;

  select nombre, dni into v_nombre, v_dni
    from public.colaboradores where id = new.colaborador_id;

  -- Normaliza el celular a formato internacional (Colombia +57 si son 10 digitos).
  -- Sin '+': WATI espera el whatsappNumber como solo digitos en la query string.
  v_celular := regexp_replace(new.celular_comprobante, '[^0-9]', '', 'g');
  if length(v_celular) = 10 then
    v_celular := '57' || v_celular;
  end if;

  v_payload := jsonb_build_object(
    'template_name', 'comprobar',
    'broadcast_name', 'comprobante_asistencia',
    'channel_number', '573160235197',
    'parameters', jsonb_build_array(
      jsonb_build_object('name', '1', 'value', coalesce(v_nombre, 'Colaborador')),
      jsonb_build_object('name', '2', 'value', upper(new.sentido)),
      jsonb_build_object('name', '3', 'value', to_char(new.fecha, 'DD/MM/YYYY')),
      jsonb_build_object('name', '4', 'value', to_char(new.hora, 'HH24:MI')),
      jsonb_build_object('name', '5', 'value', coalesce(v_dni, ''))
    )
  );

  v_url := v_base_url || '/api/v2/sendTemplateMessage?whatsappNumber=' || v_celular;

  -- Envio asincrono: pg_net encola el POST y NO bloquea el INSERT de la marca.
  -- Todo este bloque va en su propio EXCEPTION handler: la version anterior (Pabbly)
  -- no tenia ninguna escritura despues del http_post, asi que un fallo ahi nunca
  -- podia tumbar la marca. Ahora que se agrega el UPDATE de estado, un error en
  -- CUALQUIERA de los dos (net.http_post o el UPDATE) se propagaria y haria rollback
  -- del INSERT de asistencias completo si no se atrapa aqui -perderiamos la marca
  -- del conductor por un problema que no tiene nada que ver con su asistencia.
  begin
    select net.http_post(
      url     := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json',
                                     'Authorization', v_token),
      body    := v_payload
    ) into v_request_id;

    update public.asistencias
       set whatsapp_status = 'encolado',
           whatsapp_request_id = v_request_id,
           whatsapp_enviado_en = now()
     where id = new.id;
  exception when others then
    begin
      update public.asistencias
         set whatsapp_status = 'error: ' || left(sqlerrm, 200)
       where id = new.id;
    exception when others then
      null; -- si ni siquiera este UPDATE de respaldo funciona, no hay nada mas que hacer
    end;
  end;

  return new;
end;
$function$;

drop trigger if exists trg_notificar_comprobante on public.asistencias;
create trigger trg_notificar_comprobante
after insert on public.asistencias
for each row
execute function public.notificar_comprobante_whatsapp();

grant execute on function public.notificar_comprobante_whatsapp() to authenticated;
