-- Agenda de celulares para el comprobante por WhatsApp.
-- Tabla APARTE de `colaboradores` a proposito: `colaboradores` se resincroniza
-- desde el CSV/Buk y una columna nueva se podria pisar. Esta agenda es independiente
-- y se consulta/guarda por cedula (dni).

create table if not exists public.contactos_whatsapp (
  dni text primary key,
  celular text not null,
  nombre text,
  actualizado_en timestamptz not null default now(),
  actualizado_por uuid
);

alter table public.contactos_whatsapp enable row level security;

drop policy if exists "contactos_whatsapp_select_auth" on public.contactos_whatsapp;
create policy "contactos_whatsapp_select_auth"
  on public.contactos_whatsapp for select
  to authenticated
  using (true);

-- Normaliza a 10 digitos celular Colombia (acepta +57 / 57 al inicio).
create or replace function public.normalizar_celular_co(p_celular text)
returns text
language plpgsql
immutable
as $function$
declare
  v text;
begin
  v := regexp_replace(coalesce(p_celular, ''), '[^0-9]', '', 'g');
  if length(v) = 12 and left(v, 2) = '57' then
    v := right(v, 10);
  elsif length(v) = 11 and left(v, 1) = '0' then
    v := right(v, 10);
  end if;
  if length(v) <> 10 or left(v, 1) <> '3' then
    return null;
  end if;
  return v;
end;
$function$;

-- Lectura: al digitar la cedula la app pregunta si ya hay un celular guardado.
create or replace function public.obtener_celular_colaborador(p_dni text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_dni text;
  v_row public.contactos_whatsapp%rowtype;
begin
  if auth.uid() is null then
    raise exception 'No autorizado: debes iniciar sesion.';
  end if;

  v_dni := regexp_replace(coalesce(p_dni, ''), '[^0-9]', '', 'g');
  if v_dni = '' then
    return jsonb_build_object('ok', false, 'error', 'Cedula vacia.');
  end if;

  select * into v_row from public.contactos_whatsapp where dni = v_dni;

  if v_row.dni is null then
    return jsonb_build_object('ok', true, 'existe', false, 'celular', null);
  end if;

  return jsonb_build_object(
    'ok', true,
    'existe', true,
    'celular', v_row.celular,
    'actualizado_en', v_row.actualizado_en
  );
end;
$function$;

-- Guardado / actualizacion del celular de una cedula.
create or replace function public.guardar_celular_colaborador(
  p_dni text,
  p_celular text,
  p_nombre text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_dni text;
  v_cel text;
begin
  if auth.uid() is null then
    raise exception 'No autorizado: debes iniciar sesion.';
  end if;

  v_dni := regexp_replace(coalesce(p_dni, ''), '[^0-9]', '', 'g');
  if v_dni = '' then
    return jsonb_build_object('ok', false, 'error', 'Cedula vacia.');
  end if;

  v_cel := public.normalizar_celular_co(p_celular);
  if v_cel is null then
    return jsonb_build_object('ok', false, 'error',
      'El celular debe ser un numero movil colombiano de 10 digitos que empiece por 3.');
  end if;

  insert into public.contactos_whatsapp as c (dni, celular, nombre, actualizado_en, actualizado_por)
  values (v_dni, v_cel, nullif(trim(coalesce(p_nombre, '')), ''), now(), auth.uid())
  on conflict (dni) do update
    set celular = excluded.celular,
        nombre = coalesce(excluded.nombre, c.nombre),
        actualizado_en = now(),
        actualizado_por = auth.uid();

  return jsonb_build_object('ok', true, 'dni', v_dni, 'celular', v_cel);
end;
$function$;

-- Borrado: si el conductor pide que ya no le llegue el comprobante.
create or replace function public.borrar_celular_colaborador(p_dni text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_dni text;
begin
  if auth.uid() is null then
    raise exception 'No autorizado: debes iniciar sesion.';
  end if;

  v_dni := regexp_replace(coalesce(p_dni, ''), '[^0-9]', '', 'g');
  delete from public.contactos_whatsapp where dni = v_dni;
  return jsonb_build_object('ok', true);
end;
$function$;

grant execute on function public.obtener_celular_colaborador(text) to authenticated;
grant execute on function public.guardar_celular_colaborador(text, text, text) to authenticated;
grant execute on function public.borrar_celular_colaborador(text) to authenticated;
