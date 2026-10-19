-- La app de asistencia rechazaba a TODOS los conductores: "la cedula no esta activa
-- en la base de colaboradores".
--
-- La app valida la cedula contra employees (activo = true), pero lo hacia leyendo la
-- tabla completa desde el navegador. Desde el 15/16-sep employees solo la puede leer
-- gestion humana y quien tenga permiso en el Kardex (rls_solo_autorizados,
-- gestion_humana_modulos, permisos_granulares). Con la cuenta de un conductor la
-- lectura no da error: llega VACIA, y entonces ninguna cedula aparece como activa.
--
-- Esta funcion responde solo por UNA cedula y solo si esta activa, con lo que la app
-- usa para el registro (nombre, cargo, vehiculo y ruta). No abre la tabla: lo demas
-- de employees (salario, telefonos, datos personales) sigue cerrado.

create or replace function public.asistencia_empleado_activo(p_dni text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'cedula', e.cedula,
           'nombre', e.nombre,
           'cargo', e.cargo,
           'vehiculo_asociado', e.vehiculo_asociado,
           'ruta', e.ruta)
    from public.employees e
   where e.activo = true
     and length(regexp_replace(coalesce(p_dni, ''), '[^0-9A-Za-z]', '', 'g')) >= 5
     and regexp_replace(coalesce(e.cedula, ''), '[^0-9A-Za-z]', '', 'g')
         = regexp_replace(coalesce(p_dni, ''), '[^0-9A-Za-z]', '', 'g')
   order by e.created_at desc nulls last
   limit 1;
$$;

revoke all on function public.asistencia_empleado_activo(text) from public, anon;
grant execute on function public.asistencia_empleado_activo(text) to authenticated;

-- Revision (solo lee): debe decir true, true, false.
select
  exists (select 1 from pg_proc where proname = 'asistencia_empleado_activo') as funcion_creada,
  has_function_privilege('authenticated', 'public.asistencia_empleado_activo(text)', 'execute') as la_usan_los_conductores,
  has_function_privilege('anon', 'public.asistencia_empleado_activo(text)', 'execute') as sin_sesion_no;
