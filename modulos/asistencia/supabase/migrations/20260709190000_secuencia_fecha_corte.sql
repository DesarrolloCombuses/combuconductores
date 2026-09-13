-- Alinea el trigger de secuencia (entrada/salida alternada) con la misma FECHA DE
-- CORTE que usa el cliente (2026-07-09). Antes miraba TODO el historial, por lo que
-- una persona con un turno viejo abierto (ej. una entrada del 09-may sin cerrar)
-- quedaba bloqueada: el cliente la deja marcar "entrada" (ignora lo viejo) pero el
-- trigger veia "entrada -> entrada" y rechazaba el INSERT con 400. Resultado: la
-- marca se enviaba a Buk pero NO quedaba en la base local (inconsistencia).
--
-- Ahora el trigger solo considera marcas del 2026-07-09 en adelante, igual que el
-- cliente. Las marcas anteriores (turnos viejos) se limpian aparte, manualmente.
-- La alternancia sigue validandose normal para todas las marcas desde el corte.

create or replace function public.validar_secuencia_asistencia()
returns trigger
language plpgsql
as $function$
declare
  ultimo_sentido text;
begin
  select sentido
  into ultimo_sentido
  from asistencias
  where colaborador_id = new.colaborador_id
    and fecha >= date '2026-07-09'   -- fecha de corte: ignora turnos viejos
  order by fecha desc, hora desc, created_at desc
  limit 1;

  if ultimo_sentido is null then
    if new.sentido <> 'entrada' then
      raise exception 'La primera marca debe ser entrada.';
    end if;
  elsif ultimo_sentido = new.sentido then
    raise exception 'No se permite registrar dos marcas consecutivas del mismo tipo.';
  end if;

  return new;
end;
$function$;
