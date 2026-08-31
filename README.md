# CRM — Opportunities module (code showcase)

Extracto **curado y de solo lectura** del módulo de **Opportunities** (pipeline
comercial) de un CRM que construí. Es el slice más "backend": modela un pipeline de
ventas como una **máquina de estados** con transiciones controladas, y orquesta el
handoff hacia el área de reclutamiento.

> **Esto no es la app completa ni corre por sí sola.** Es una selección de archivos
> representativos. Se quitaron todos los datos, secretos y credenciales; los emails
> que aparecen son ficticios (`@example.com`). Módulos compartidos (el esquema de
> Prisma, el **módulo de Jobs de HR**, componentes de UI) se **referencian pero se
> omiten** a propósito.

## El vínculo con HR: de Opportunity a Job Order

La parte más interesante de este módulo es cómo **conecta el pipeline comercial con
el de reclutamiento (HR)**:

- Una Opportunity puede vincularse a uno o varios **Job Orders** (jobs). La relación
  es **1:N y el FK vive del lado del Job** (`Job.opportunityId`), no de la Opp —
  hay funciones dedicadas para linkear/deslinkear en vez de manejarlo como un campo
  más.
- **Cuando una Opportunity avanza a la etapa `Searching`, el sistema crea
  automáticamente un Job Order** del lado de HR a partir de los datos de la Opp
  (`prisma.job.create(...)`) e inicializa sus stages (`getOrInitJobStages`). Es el
  momento en que un deal comercial "ganado/en búsqueda" se convierte en una vacante
  concreta para que el equipo de reclutamiento empiece a sourcear candidatos.
- Al archivar o reabrir una Opp, la lógica propaga el efecto sobre sus Jobs
  vinculados y revalida las rutas de `/jobs`.

Ese cruce commercial → HR es lo que hace que el CRM sea un solo sistema y no dos
apps sueltas.

## Qué más muestra

- **Máquina de estados del pipeline** (`app/lib/stageTransition.ts`,
  `opportunityStages.ts`, `pipelineStages.ts`): etapas, transiciones válidas y los
  efectos secundarios de cada cambio de etapa.
- **Detalle de la Opportunity** (`app/commercial/opportunities/[id]/page.tsx`):
  vista completa con etapas, jobs vinculados, documentos y actividad.
- **Listado con filtros** y **alta** de oportunidades.
- **Notificaciones por email** en cambios de etapa (SMTP vía variables de entorno;
  destinatarios ficticios en este extracto).

## Stack

Next.js (App Router) · TypeScript · React · Server Actions · Prisma · Nodemailer
(esquema y módulo de Jobs omitidos en este extracto).

## Estructura del extracto

```
app/
├── commercial/opportunities/
│   ├── page.tsx                     listado con filtros
│   ├── OpportunitiesFiltersDropdown.tsx
│   ├── new/page.tsx                 alta
│   └── [id]/page.tsx                detalle (etapas, jobs vinculados, docs)
├── actions/
│   ├── commercial/opportunity.ts    lógica de negocio (incl. auto-creación de Job Order)
│   └── opportunityStages.ts         gestión de etapas
├── lib/
│   ├── stageTransition.ts           transiciones válidas del pipeline
│   ├── opportunityStages.ts         definición de etapas
│   └── pipelineStages.ts
├── components/modals/
│   ├── OpportunityStagesModal.tsx
│   └── StageChangeInfoModal.tsx
└── api/opportunities/upload-doc/     subida de documentos
```

## Notas

- **Sanitizado para portfolio:** sin base, sin `.env`, sin claves, sin datos reales.
- **Solo lectura:** pensado para leerse, no para `npm install && run`.
