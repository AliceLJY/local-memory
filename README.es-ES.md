

<div align="center">

# RecallNest

**Capa de memoria compartida para Claude Code, Codex y Gemini CLI**

*Una memoria. Tres terminales. Un contexto que sobrevive entre ventanas.*

Un sistema de memoria primero-local respaldado por LanceDB que convierte el historial de conversaciones disperso en conocimiento reutilizable — compartido entre tus agentes de codificación, recuperado automáticamente.

[![GitHub](https://img.shields.io/github/stars/AliceLJY/recallnest?style=social)](https://github.com/AliceLJY/recallnest)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Runtime](https://img.shields.io/badge/Runtime-Bun_|_Node.js_18+-f9f1e1?logo=bun)](https://bun.sh)
[![LanceDB](https://img.shields.io/badge/LanceDB-Vector+FTS-orange)](https://lancedb.com)
[![MCP](https://img.shields.io/badge/MCP-43_tools-blue)](https://modelcontextprotocol.io)
[![Tests](https://img.shields.io/badge/Tests-1742_pass-brightgreen)](https://github.com/AliceLJY/recallnest)
[![CC Plugin](https://img.shields.io/badge/Claude_Code-Plugin-blueviolet)](https://github.com/AliceLJY/recallnest)

**English** | [简体中文](README_CN.md) | [Hoja de ruta](ROADMAP.md)

</div>

---

## ¿Por qué RecallNest?

Los agentes de codificación olvidan todo entre ventanas. Tu contexto: configuraciones de proyecto, decisiones de depuración, mapeos de entidades, se dispersa entre Claude Code, Codex y Gemini CLI sin una memoria compartida.

RecallNest soluciona esto: **una única capa de memoria respaldada por LanceDB que tus agentes de codificación leen y escriben**. El contexto almacenado en una ventana se recupera automáticamente en otra. Las sesiones crean puntos de control al salir y se reanudan al iniciar. La memoria decae, evoluciona y se autoorganiza: no es solo un almacenamiento de registros crudos.


## Inicio Rápido

### Opción A: Plugin para Claude Code (recomendado)

```bash
/plugin marketplace add AliceLJY/recallnest
/plugin install recallnest@AliceLJY
```

RecallNest se inicia automáticamente con Claude Code. No se necesita configuración manual de MCP.

> **Requisitos:** [Bun](https://bun.sh) (recomendado) o Node.js 18+. Las dependencias se instalan en el primer inicio.

### Opción B: npm install

```bash
npx recallnest --help          # ejecutar directamente
# o
npm install -g recallnest      # instalar globalmente
recallnest doctor
```

Funciona con Node.js 18+ (vía tsx) o Bun. No se necesita clonar git.

### Opción C: Configuración manual

```bash
git clone https://github.com/AliceLJY/recallnest.git
cd recallnest
bun install
cp config.json.example config.json
cp .env.example .env
# Editar .env → agrega tu JINA_API_KEY
```

### Iniciar el servidor

```bash
bun run api
# → RecallNest API ejecutándose en http://localhost:4318
```

### Prueba rápida

```bash
# Almacenar una memoria
curl -X POST http://localhost:4318/v1/store \
  -H "Content-Type: application/json" \
  -d '{"text": "User prefers dark mode", "category": "preferences"}'

# Recuperar memorias
curl -X POST http://localhost:4318/v1/recall \
  -H "Content-Type: application/json" \
  -d '{"query": "user preferences"}'

# Verificar estadísticas
curl http://localhost:4318/v1/stats
```

### Conectar tus terminales

```bash
bash integrations/claude-code/setup.sh
bash integrations/gemini-cli/setup.sh
bash integrations/codex/setup.sh
```

Cada script instala el acceso a MCP y las reglas de continuidad gestionadas, para que `resume_context` se dispare automáticamente en ventanas nuevas.

### Indexar conversaciones existentes

```bash
bun run src/cli.ts ingest --source all
bun run seed:continuity
bun run src/cli.ts doctor
```

---

## Interfaz Web

<p align="center">
  <img src="assets/dashboard.png" alt="Panel de Control de RecallNest" width="800" />
  <br><em>Panel de control — conteo total, distribución por categoría, puntuación de salud y tendencias de crecimiento de un vistazo.</em>
</p>

<p align="center">
  <img src="assets/screenshots/ui-full.png" alt="Entorno de Búsqueda de RecallNest" width="800" />
  <br><em>Entorno de búsqueda — búsqueda híbrida con filtrado por etiquetas temáticas, 4 perfiles de recuperación, explorador de habilidades y gestión de activos.</em>
</p>

<p align="center">
  <img src="assets/knowledge-graph.png" alt="Grafo de Conocimiento de RecallNest" width="800" />
  <br><em>Grafo de conocimiento — visualización interactiva de fuerza dirigida con puentes semánticos que revelan conexiones entre dominios.</em>
</p>

```bash
bun run src/ui-server.ts
# → http://localhost:4317
```

---

## Capacidades Principales

### Acceso y Configuración

| Capacidad | Descripción |
|---|---|
| **Plugin CC** | Instálalo en Claude Code con un solo comando, sin configuración manual |
| **Índice Compartido** | Un único almacén LanceDB para Claude Code, Codex y Gemini CLI |
| **Interfaz Dual** | MCP (stdio) para herramientas CLI + API HTTP para agentes personalizados |
| **Configuración en un clic** | Los scripts de integración instalan el acceso a MCP y las reglas de continuidad |

### Recuperación y Continuidad

| Capacidad | Descripción |
|---|---|
| **Recuperación Híbrida** | 6 canales: vector + BM25 + multi-vector L0/L1/L2 + grafo de conocimiento (PPR) |
| **4 Perfiles de Recuperación** | predeterminado, escritura, depuración, verificación de hechos — ajustados para diferentes tareas |
| **Continuidad de Sesión** | `checkpoint_session` + `resume_context` (modos completo/ligero/resumen) con protección de estado del repositorio |
| **Destilador de Sesión** | Compresión de conversación de 3 capas: microcompactado → resumen LLM → extracción de conocimiento |
| **Importación de Conversaciones** | Importar desde Claude Code, Claude.ai, ChatGPT, Slack y texto plano |
| **Etiquetas de Tema** | Segmentación temática intra-alcance — detectadas automáticamente, filtrables en la búsqueda |
| **Auxiliar de Ámbito Relacionado** | Búsqueda `includeRelatedScopes` opcional sobre `scopeRelations` configurados, mostrada por separado del ranking principal de ámbito |

### Ciclo de Vida de la Memoria y Gobernanza

| Capacidad | Descripción |
|---|---|
| **Evolución de la Memoria** | Cadenas de sustitución, puntuación de decaimiento, importancia LLM, consolidación, archivado |
| **Promoción Inteligente** | Evidencia → memoria duradera con protecciones de conflicto, resolución de fusión y registro de auditoría |
| **Niveles de Privacidad** | 4 niveles (`ephemeral` / `private` / `durable` / `shared`) con olvido en cascada |
| **Control de Admisión** | Control en tiempo de escritura: filtro de ruido, umbral de importancia, deduplicación, limitación de tasa |
| **Lint de Memoria** | Detección de contradicciones, duplicados, entradas obsoletas y huérfanas con puntuación de salud |
| **Consolidación Offline** | Comando `dream`: agrupamiento, fusión y poda de memorias acumuladas |

### Razonamiento y Estructura

| Capacidad | Descripción |
|---|---|
| **Grafo de Conocimiento** | Grafo de relaciones de entidades con algoritmo PPR para preguntas de múltiples saltos |
| **Recuperación Constructiva** | Expansión de candidatos de múltiples fuentes + reconstrucción de contexto fundamentado |
| **Arquitectura Narrativa** | Metadatos autobiográficos de 3 capas (periodo-vida → evento-general → evento-específico) |
| **Memoria de Habilidades** | Almacenar, recuperar y promover habilidades ejecutables a partir de patrones recurrentes |
| **Recordatorios Predictivos** | Motor de predicción de señales conductuales que muestra sugerencias de "podrías necesitar esto" |
| **6 Categorías** | perfil, preferencias, entidades, eventos, casos, patrones — con estrategias de fusión conscientes de la categoría |

### Visibilidad y Operaciones

| Capacidad | Descripción |
|---|---|
| **Panel de Control** | Interfaz web con estadísticas, distribución por categoría, tendencias de crecimiento y salud |
| **Observación de Flujos de Trabajo** | Registros dedicados de salud de flujo de trabajo solo para agregar, fuera de la memoria regular |
| **Activos Estructurados** | Fijaciones (pins), informes y resúmenes destilados — no solo registros crudos |
| **Revisión de Datos** | Verificaciones de salud de calidad de datos en el almacén de memoria (incluida salud de origen) |
| **Pulsos de Estado del Origen** | Rastreo automático de salud de ingestión por origen de datos con alertas de antigüedad |
| **Exportar Grafo** | Exportar visualización interactiva del grafo de conocimiento en HTML |
| **Operaciones por Lotes** | Almacenar hasta 20 memorias en una sola llamada con deduplicación |
| **Marco de Conectores** | Formato estándar connector-v1 para orígenes de datos externos con adaptadores de ejemplo |

---

## Novedades en v2.1: Memoria Informada por la Filosofía

La v2.0 construyó la plataforma de memoria operativa; la v2.1 añadió comportamientos de memoria informados por la filosofía.

Cinco mejoras derivadas de 9 dimensiones de investigación en filosofía de la memoria, cada una mapeada a ingeniería concreta:

- **Decaimiento Consciente de la Emoción** *(Teoría de la Memoria Afectiva)* — Las memorias con un fuerte contenido emocional decaen un 20-30% más lento. La detección de emociones basada en palabras clave calcula `salience` (significancia mnemotécnica), que se alimenta en la fórmula de vida media de Weibull y una puntuación de evolución de 4 factores rebalanceada. Cero costo de LLM.

- **Capa de Ética de la Memoria** *(Derecho al Olvido / Art. 17 del GDPR)* — Cuatro niveles de privacidad (`ephemeral` / `private` / `durable` / `shared`). Motor de olvido en cascada que propaga la eliminación a través de tripletas del grafo de conocimiento, cadenas de evolución, activos fijados e informes. Registro de auditoría completo. Herramienta MCP `forget_memory` para eliminación impulsada por agentes.

- **Narrativa Autobiográfica** *(Teoría de la Identidad Narrativa / Modelo de 3 capas de Conway)* — Las memorias se etiquetan con la jerarquía `lifePeriod → generalEvent → specificEvent`, ortogonal a las 6 categorías existentes. La recuperación extrae hermanos narrativos. El renderizado de contexto agrupa por periodo de vida. Etiquetador basado en reglas con soporte para EN+CN.

- **Recuperación Constructiva** *(Teoría de la Simulación / Michaelian)* — En lugar de devolver texto almacenado en bruto, RecallNest ahora reconstruye el contexto a partir de un conjunto de candidatos expandido: vecinos del grafo de conocimiento + cadenas de evolución + miembros del clúster + hermanos narrativos. La cobertura fundamentada mediante mapa de origen reemplaza la superposición léxica. Las contradicciones se detectan y marcan.

- **Memoria Prospectiva Predictiva** *(Viaje en el Tiempo Mental / Tulving)* — Motor de predicción heurística que muestra recordatorios de "podrías necesitar esto" a partir de señales conductuales: bucles abiertos de puntos de control obsoletos, observaciones de flujo de trabajo corregidas, memorias latentes de alta frecuencia y temas de consulta no cubiertos. Cero costo de LLM. Caducidad automática a los 7 días si no se aceptan.

---

## Novedades en v2.2: Endurecimiento de la Calidad de Recuperación

La v2.1 añadió comportamiento informado por la filosofía; la v2.2 cierra las últimas tres brechas a nivel de motor identificadas por un escaneo de investigación de vanguardia (ACC, PI-LLM, TSM).

- **Metainformación de Confianza de la Memoria** *(ACC / UQ de Proceso Dual)* — Cada memoria ahora incluye `ConfidenceMetadata` estructurada (puntuación, nivel de confiabilidad: `direct` / `inferred` / `hearsay`). Asignado automáticamente desde el origen en la escritura (`manual` = 0.9, `agent` = 0.7, `conversation_import` = 0.5). Las puntuaciones de recuperación se ponderan por confianza. `resume_context` etiqueta los elementos de baja confianza con `[低置信]`.

- **Detección de Interferencia + Puerta de Olvido Activo** *(PI-LLM / SleepGate)* — La detección de clústeres semánticos identifica grupos de memorias casi duplicadas que compiten por la recuperación. El RIF mejorado conserva solo los top-K (predeterminado 3) por clúster; los extras se degradan un 50% en lugar de eliminarse. Advertencia previa en tiempo de escritura: cuando un ámbito acumula ≥5 memorias activas de alta similitud, la más débil se marca como `pending_review`. `data_checkup` informa la densidad de interferencia.

- **Ventanas de Validez Temporal** *(TSM / TiMem / Zep)* — `store_memory` acepta `validUntil` (vencimiento) y `eventTime` (cuándo ocurrió realmente el evento). `search_memory` admite `validAt` (consulta en un punto en el tiempo) y `includeExpired` (degradar 80% en lugar de ocultar). La recolección de basura automática (Auto-GC) aplica una aceleración de decaimiento 2× a las memorias expiradas.

- **Auto-GC Ajustado por Uso** *(desactivado por defecto)* — `RECALLNEST_USAGE_DECAY=true` habilita una penalización de memoria fría solo para GC cuando la recuperación constructiva también está activa. Las memorias frías descuentan el componente de frecuencia en lugar de cambiar el ranking de recuperación en línea.

---

## Novedades en v2.3: Ecosistema de Conectores + Salud del Origen

La v2.2 endureció la calidad de recuperación; la v2.3 abre RecallNest a orígenes de datos externos con un marco de conectores estándar y monitoreo operativo de salud.

- **Estándar Connector-v1** *(GB-2)* — Un formato JSON (`ConnectorOutputV1`) que cualquier script externo puede producir. Cofres de Obsidian, correos electrónicos, feeds RSS, archivos de registro: normaliza una vez, ingiere a través de la canalización completa de deduplicación/incrustación/extracción. Consulta [`docs/connector-spec.md`](docs/connector-spec.md) para la especificación y [`connectors/examples/`](connectors/examples/) para esqueletos de adaptadores (correo, registros, RSS).

- **Ingestión de Cofre Obsidian** *(GB-1)* — Conector de Obsidian de primer orden: escanea archivos `.md`, extrae frontmatter + wikilinks, mapea la estructura de carpetas a etiquetas. Un solo comando: `lm ingest --obsidian /ruta/al/cofre`.

- **Monitoreo de Salud del Origen** *(GB-3)* — Cada ingestión de conector escribe un pulso en `data/source-heartbeat.json`. `data_checkup` marca orígenes obsoletos (>7d advertencia, >30d error). `doctor --ci` muestra un resumen de pulsos por origen con antigüedad legible por humanos.

---

## Arquitectura

```
┌──────────────────────────────────────────────────────────┐
│                     Client Layer                          │
├──────────┬──────────┬──────────┬──────────────────────────┤
│ Claude   │ Gemini   │ Codex    │ Custom Agents / curl     │
│ Code     │ CLI      │          │                          │
└────┬─────┴────┬─────┴────┬─────┴──────┬──────────────────┘
     │          │          │            │
     └──── MCP (stdio) ───┘     HTTP API (port 4318)
                │                       │
                ▼                       ▼
┌──────────────────────────────────────────────────────────┐
│                   Integration Layer                       │
│  ┌─────────────────────┐  ┌────────────────────────────┐ │
│  │  MCP Server         │  │  HTTP API Server           │ │
│  │  43 tools           │  │  21 endpoints              │ │
│  └─────────┬───────────┘  └──────────┬─────────────────┘ │
└────────────┼─────────────────────────┼───────────────────┘
             └──────────┬──────────────┘
                        ▼
┌──────────────────────────────────────────────────────────┐
│                     Core Engine                           │
│                                                           │
│  ┌────────────┐  ┌────────────┐  ┌─────────────────────┐ │
│  │ Retriever  │  │ Classifier │  │ Context Composer     │ │
│  │ (vector +  │  │ (6 cats)   │  │ (resume_context)     │ │
│  │ BM25 + RRF)│  │            │  │                      │ │
│  └────────────┘  └────────────┘  └──────────────────────┘ │
│  ┌────────────┐  ┌────────────┐  ┌─────────────────────┐ │
│  │ Decay      │  │ Conflict   │  │ Capture Engine       │ │
│  │ Engine     │  │ Engine     │  │ (evidence → durable) │ │
│  │ (Weibull)  │  │ (audit +   │  │                      │ │
│  │            │  │  merge)    │  │                      │ │
│  └────────────┘  └────────────┘  └──────────────────────┘ │
└──────────────────────────┬───────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────┐
│                    Storage Layer                          │
│  ┌─────────────────────┐  ┌────────────────────────────┐ │
│  │ LanceDB             │  │ Jina Embeddings v5         │ │
│  │ (vector + columnar) │  │ (1024-dim, task-aware)     │ │
│  └─────────────────────┘  └────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

### Diseño Interno

- **Plegamiento Dinámico L0 / L1 / L2** — cada memoria almacena 3 capas de granularidad (línea única / resumen con viñetas / contenido completo); la recuperación selecciona dinámicamente qué capa devolver basándose en la puntuación de relevancia y el presupuesto de tokens
- **Decaimiento Weibull + Modulación Emocional** — las memorias decaen a lo largo de una curva paramétrica de Weibull; las puntuaciones de importancia modulan la vida media, y la significancia emocional la extiende aún más (hasta un 30%)
- **Prefiltro Vectorial + Deduplicación LLM** — el 90% de las decisiones de deduplicación usan similitud coseno económica (>= 0.92); solo los casos fronterizos invocan el juicio del LLM, manteniendo los costos bajos sin sacrificar precisión
- **Estrategias de Fusión Conscientes de Categoría** — `profile` y `preferences` usan fusión ante conflicto (el más reciente gana); `events` y `cases` usan solo agregar (historial preservado)
- **Puntuación de Visualización vs Puntuación de Eliminación** — recuperación de doble vía: el piso de nivel impide que las memorias centrales caigan nunca, mientras que el impulso de decaimiento permite que las memorias frescas emerjan temporalmente sin desplazar permanentemente a las estables

> Análisis detallado de la arquitectura: [`docs/architecture.md`](docs/architecture.md)

---

## Interfaces

RecallNest sirve dos interfaces:

- **MCP** — para Claude Code, Gemini CLI y Codex (acceso nativo a herramientas)
- **API HTTP** — para agentes personalizados, aplicaciones basadas en SDK y cualquier cliente HTTP

### Ejemplos de marcos de agentes

Los ejemplos se encuentran en [`integrations/examples/`](integrations/examples/):

| Marco | Ejemplo | Lenguaje |
|-----------|---------|----------|
| [Claude Agent SDK](integrations/examples/claude-agent-sdk/) | `memory-agent.ts` | TypeScript |
| [OpenAI Agents SDK](integrations/examples/openai-agents-sdk/) | `memory-agent.py` | Python |
| [LangChain](integrations/examples/langchain/) | `memory-chain.py` | Python |

---

<details>
<summary><strong>Herramientas MCP (43 herramientas)</strong></summary>

| Herramienta | Descripción |
|------|-------------|
| `workflow_observe` | Almacena una observación de flujo de trabajo solo para agregar fuera de la memoria regular; acepta `idempotencyKey` para escrituras seguras ante reintentos |
| `workflow_health` | Inspecciona la salud de la observación del flujo de trabajo o muestra un panel de flujo degradado |
| `workflow_evidence` | Construye un paquete de evidencia para un primitivo de flujo de trabajo |
| `store_memory` | Almacena una memoria duradera para ventanas futuras |
| `store_workflow_pattern` | Almacena un flujo de trabajo reutilizable como memoria duradera de `patterns` |
| `store_case` | Almacena un par problema-solución reutilizable como memoria duradera de `cases` |
| `promote_memory` | Promueve explícitamente la evidencia a memoria duradera |
| `promote_scan` | Escanea evidencia reciente y promociona automáticamente memorias calificadas a almacenamiento duradero |
| `list_conflicts` | Lista o inspecciona candidatos a conflicto de promoción |
| `audit_conflicts` | Resumir prioridades de conflictos obsoletos/escalados |
| `escalate_conflicts` | Vista previa o aplicar metadatos de escalación de conflicto |
| `resolve_conflict` | Resolver un candidato de conflicto almacenado (conservar / aceptar / fusionar) |
| `checkpoint_session` | Almacena el estado de trabajo activo actual fuera de la memoria duradera; acepta `idempotencyKey` para escrituras seguras ante reintentos |
| `latest_checkpoint` | Inspecciona el último punto de control guardado por sesión o ámbito |
| `resume_context` | Compone el contexto de inicio para una ventana nueva |
| `search_memory` | Recuperación proactiva al inicio de la tarea |
| `explain_memory` | Explica por qué coincidieron las memorias |
| `distill_memory` | Destila resultados en un informe compacto |
| `brief_memory` | Crea un informe estructurado y lo reindexa |
| `pin_memory` | Promueve una memoria con ámbito a un activo fijado |
| `export_memory` | Exporta un informe de memoria destilada al disco |
| `list_pins` | Lista memorias fijadas |
| `list_assets` | Lista todos los activos estructurados |
| `list_dirty_briefs` | Vista previa de activos de informe obsoletos creados antes de las reglas de limpieza |
| `clean_dirty_briefs` | Archiva activos de informe sucios y elimina sus filas indexadas |
| `memory_stats` | Muestra estadísticas del índice |
| `memory_drill_down` | Inspecciona una entrada de memoria específica con metadatos y procedencia completos |
| `auto_capture` | Extrae y almacena heurísticamente señales de memoria del texto (cero llamadas a LLM) |
| `set_reminder` | Establece un recordatorio de memoria prospectiva para que aparezca en una sesión futura |
| `consolidate_memories` | Agrupa memorias casi duplicadas y las fusiona (ejecución en seco por defecto) |
| `store_skill` | Almacena una habilidad ejecutable con condiciones de activación y verificación |
| `retrieve_skill` | Recupera habilidades ejecutables coincidentes por similitud semántica |
| `scan_skill_promotions` | Escanea casos/patrones en busca de candidatos a promoción a habilidades |
| `list_tools` | Descubre herramientas disponibles por nivel (núcleo/avanzado/completo) |
| `batch_store` | Almacena hasta 20 memorias en una sola llamada con deduplicación |
| `distill_session` | Destila una conversación en conocimiento estructurado mediante una canalización de 3 capas |
| `import_conversations` | Importa conversaciones desde Claude Code, ChatGPT, Slack y más |
| `data_checkup` | Ejecuta verificaciones de salud de calidad de datos en el almacén de memoria |
| `dream` | Ejecuta consolidación de memoria offline (agrupamiento, fusión, poda) |
| `memory_lint` | Ejecuta verificaciones de calidad de memoria: contradicciones, duplicados, entradas obsoletas, huérfanas |
| `forget_memory` | Elimina en cascada una memoria con limpieza del grafo de conocimiento, archivado de fijaciones y registro de auditoría |
| `export_graph` | Exporta memorias como un grafo de conocimiento HTML interactivo |

</details>

<details>
<summary><strong>API HTTP (21 endpoints)</strong></summary>

URL base: `http://localhost:4318`

| Endpoint | Método | Descripción |
|----------|--------|-------------|
| `/v1/recall` | POST | Búsqueda semántica rápida |
| `/v1/store` | POST | Almacenar una nueva memoria |
| `/v1/capture` | POST | Almacenar múltiples memorias estructuradas |
| `/v1/pattern` | POST | Almacenar un patrón de flujo de trabajo estructurado |
| `/v1/case` | POST | Almacenar un caso estructurado de problema-solución |
| `/v1/promote` | POST | Promover evidencia a memoria duradera |
| `/v1/conflicts` | GET | Listar o inspeccionar candidatos a conflicto de promoción |
| `/v1/conflicts/audit` | GET | Resumir prioridades de conflictos obsoletos/escalados |
| `/v1/conflicts/escalate` | POST | Vista previa o aplicar metadatos de escalación de conflicto |
| `/v1/conflicts/resolve` | POST | Resolver un candidato de conflicto almacenado (conservar / aceptar / fusionar) |
| `/v1/checkpoint` | POST | Almacenar el punto de control de trabajo actual |
| `/v1/workflow-observe` | POST | Almacenar una observación de flujo de trabajo fuera de la memoria duradera |
| `/v1/checkpoint/latest` | GET | Obtener el último punto de control por sesión o ámbito |
| `/v1/workflow-health` | GET | Inspeccionar la salud del flujo de trabajo o devolver un panel de flujo degradado |
| `/v1/workflow-evidence` | GET | Construir un paquete de evidencia de flujo de trabajo a partir de observaciones de incidencias recientes |
| `/v1/resume` | POST | Componer el contexto de inicio para una ventana nueva |
| `/v1/search` | POST | Búsqueda avanzada con metadatos completos |
| `/v1/stats` | GET | Estadísticas de memoria |
| `/v1/lint` | GET | Informe de lint de calidad de memoria |
| `/v1/health` | GET | Verificación de salud |

Documentación completa: [`docs/api-reference.md`](docs/api-reference.md)

</details>

<details>
<summary><strong>Comandos CLI</strong></summary>

```bash
# Buscar y explorar
bun run src/cli.ts search "tu consulta"
bun run src/cli.ts explain "tu consulta" --profile debug
bun run src/cli.ts distill "tema" --profile writing
bun run src/cli.ts stats

# Observación de flujo de trabajo
bun run src/cli.ts workflow-observe resume_context "Ventana nueva omitió la recuperación de continuidad." --outcome missed --scope project:recallnest --idempotency-key smoke-2026-06-26
bun run src/cli.ts workflow-health resume_context --scope project:recallnest
bun run src/cli.ts workflow-evidence checkpoint_session --scope project:recallnest

# Gestión de conflictos
bun run src/cli.ts conflicts list
bun run src/cli.ts conflicts list --attention resolved
bun run src/cli.ts conflicts list --group-by cluster --attention resolved
bun run src/cli.ts conflicts audit
bun run src/cli.ts conflicts audit --export --format md
bun run src/cli.ts conflicts escalate --attention stale
bun run src/cli.ts conflicts show af70545a
bun run src/cli.ts conflicts resolve af70545a --keep-existing
bun run src/cli.ts conflicts resolve af70545a --merge
bun run src/cli.ts conflicts resolve --all --keep-existing --status open

# Salud de memoria y visualización
bun run src/cli.ts lint                         # informe de calidad de memoria
bun run src/cli.ts lint --scope project:myapp   # verificar un ámbito específico
bun run src/cli.ts graph --open                 # exportar y abrir grafo de conocimiento
bun run src/cli.ts graph --max-nodes 50         # grafo más pequeño

# Ingestión y diagnóstico
bun run src/cli.ts ingest --source all
bun run src/cli.ts doctor
```

</details>

---

## Soporte Multilingüe

RecallNest funciona de inmediato con inglés. Para memoria multilingüe (chino, japonés, tailandés y más de 20 idiomas), instala [babel-memory](https://github.com/AliceLJY/babel-memory) con los paquetes de idiomas que necesites:

```bash
# Chino
npm install babel-memory jieba-wasm

# Japonés
npm install babel-memory @sglkc/kuromoji

# Tailandés
npm install babel-memory wordcut

# Idiomas europeos (alemán, francés, español, ruso, etc.)
npm install babel-memory snowball-stemmers

# Múltiples idiomas a la vez
npm install babel-memory jieba-wasm @sglkc/kuromoji snowball-stemmers
```

RecallNest detecta automáticamente babel-memory al iniciar: no se necesita configuración. Sin babel-memory, RecallNest sigue funcionando perfectamente con la búsqueda de texto BM25 estándar.

---

## Estado del Proyecto y Hoja de Ruta

RecallNest está en mantenimiento activo. Todas las fases principales de la arquitectura están completas: consulta la [Hoja de Ruta](ROADMAP.md) completa para las prioridades actuales y planes futuros.

---

## Relación con memory-lancedb-pro

RecallNest comenzó como una bifurcación de [memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro) y comparte sus ideas centrales sobre recuperación híbrida, modelado de decaimiento y memoria-como-sistema-de-ingeniería. La diferencia clave:

- **memory-lancedb-pro** es un plugin para OpenClaw: agrega memoria a largo plazo a un único agente OpenClaw.
- **RecallNest** es una capa de memoria independiente: sirve a Claude Code, Codex y Gemini CLI simultáneamente a través de MCP + API HTTP, con continuidad de sesión, activos estructurados y gestión de conflictos incorporados.

## Créditos

| Origen | Contribución |
|--------|-------------|
| [memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro) por [@win4r](https://github.com/win4r) | Base de bifurcación: recuperación híbrida, modelado de decaimiento y arquitectura de memoria |
| Claude Code | Base y andamiaje temprano del proyecto |
| OpenAI Codex | Productización y expansión de MCP |

Agradecimiento especial a Qin Chao ([@win4r](https://github.com/win4r)) y al equipo de [CortexReach](https://github.com/CortexReach) por el trabajo fundamental.

<details>
<summary><strong>Ecosistema</strong></summary>

Parte del flujo de trabajo de IA de código abierto **小试AI**:

| Proyecto | Descripción |
|---------|-------------|
| [babel-memory](https://github.com/AliceLJY/babel-memory) | Preprocesamiento multilingüe para BM25: más de 27 idiomas, cero dependencias |
| cc-empire *(privado)* | Ganchos/reglas/metodología: el tejido conectivo de todo el ecosistema |
| [telegram-ai-bridge](https://github.com/AliceLJY/telegram-ai-bridge) | Bots de Telegram para Claude, Codex y Gemini |
| [tg-bridge-channel](https://github.com/AliceLJY/tg-bridge-channel) | Puente hermano de Telegram que usa sesiones en segundo plano de Claude Agent View |
| [wechat-ai-bridge](https://github.com/AliceLJY/wechat-ai-bridge) | Ejecutar Claude Code / Codex / Gemini en WeChat con gestión de sesiones |
| [openclaw-tunnel](https://github.com/AliceLJY/openclaw-tunnel) | Puente CLI host ↔ Docker (modo de mantenimiento: solo para pruebas de LanceDB) |
| [digital-clone-skill](https://github.com/AliceLJY/digital-clone-skill) | Construir clones digitales a partir de datos de corpus |
| [claude-code-studio](https://github.com/AliceLJY/claude-code-studio) | Plataforma de colaboración multisesión para Claude Code |
| [workflow-orchestrator](https://github.com/AliceLJY/workflow-orchestrator) | Orquestador de canalización de lenguaje natural para Claude Code |

</details>

## Licencia

MIT
