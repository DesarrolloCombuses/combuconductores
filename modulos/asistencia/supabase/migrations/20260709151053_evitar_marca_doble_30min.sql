-- Blindaje anti marca doble a nivel de base de datos.
-- Rechaza cualquier INSERT en public.asistencias cuando ya exista otra marca
-- del MISMO colaborador y MISMO sentido (entrada/salida) dentro de 30 minutos.
-- Complementa la validacion del cliente (que se puede saltar) y la restriccion
-- de "misma hora exacta". Aplica a TODOS los origenes (web, movil, manual, etc).

-- Indice para que la verificacion sea eficiente.
create index if not exists idx_asistencias_colab_sentido_fecha_hora
  on public.asistencias (colaborador_id, sentido, fecha, hora);

create or replace function public.evitar_marca_doble()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
    from public.asistencias a
    where a.colaborador_id = new.colaborador_id
      and a.sentido = new.sentido
      and a.id is distinct from new.id
      and abs(
        extract(epoch from ((new.fecha + new.hora) - (a.fecha + a.hora)))
      ) < 1800  -- 30 minutos en segundos
  ) then
    raise exception
      'MARCA_DOBLE: ya existe una % del mismo colaborador en menos de 30 minutos', new.sentido
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_evitar_marca_doble on public.asistencias;

create trigger trg_evitar_marca_doble
before insert on public.asistencias
for each row
execute function public.evitar_marca_doble();
