-- Constancia de que el conductor confirmó el vehículo antes de validar
-- tiquetes en Distribusion (módulo Tiquetes del Portal del Conductor).
--
-- El portal no puede fijar el bus dentro de la página de Distribusion (es otro
-- dominio). Lo que hace es mostrarle al conductor qué vehículo debe
-- seleccionar y guardar aquí que lo confirmó, con su cédula y la hora.

create table if not exists public.portal_confirmaciones_tiquetes (
  id            uuid primary key default gen_random_uuid(),
  -- Lo genera el teléfono. Sin señal la confirmación espera en el dispositivo
  -- y se reintenta; con este id único un reintento nunca duplica la fila.
  id_local      text not null unique,
  -- Hora del teléfono al confirmar (la que importa). created_at es cuándo llegó.
  confirmado_en timestamptz not null,
  created_at    timestamptz not null default now(),
  dni           text not null,
  conductor     text,
  vehiculo      text not null,
  fecha_turno   date,
  turno         smallint,
  user_id       uuid default auth.uid() references auth.users (id),
  user_email    text
);

comment on table public.portal_confirmaciones_tiquetes is
  'Portal del Conductor: confirmación del vehículo antes de abrir el validador de tiquetes de Distribusion.';

create index if not exists portal_confirmaciones_tiquetes_vehiculo_idx
  on public.portal_confirmaciones_tiquetes (vehiculo, confirmado_en desc);

create index if not exists portal_confirmaciones_tiquetes_dni_idx
  on public.portal_confirmaciones_tiquetes (dni, confirmado_en desc);

alter table public.portal_confirmaciones_tiquetes enable row level security;

-- El portal solo inserta, a nombre del usuario con sesión. Consultar se hace
-- desde el panel de Supabase (service_role no pasa por RLS).
drop policy if exists "portal inserta confirmaciones de tiquetes"
  on public.portal_confirmaciones_tiquetes;

create policy "portal inserta confirmaciones de tiquetes"
  on public.portal_confirmaciones_tiquetes
  for insert
  to authenticated
  with check (user_id = auth.uid());

grant insert on public.portal_confirmaciones_tiquetes to authenticated;
