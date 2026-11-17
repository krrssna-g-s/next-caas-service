Build or adapt a complete wireless-shopping composition POC in this workspace.

First inspect the existing repository, instructions, package manager,
lockfiles, installed versions, authentication integrations and component
library. Preserve existing work. If the supplied POC source is available,
adapt it rather than recreating it.

PROJECT INPUTS
- Existing POC source: [PATH, OR "NOT AVAILABLE"]
- Private atom package/repository: [PACKAGE NAME AND DOCUMENTATION PATH]
- Private package registry: [REGISTRY URL, IF APPLICABLE]
- Approved package manager: [pnpm / npm / existing repository choice]
- BFF implementation for this task: [Node.js POC / Spring Boot]
- Production target: Spring Boot BFF and Spring Boot domain services.
- Existing Next.js repository: [PATH, OR "CREATE WITHIN MONOREPO"]

Do not request credentials in chat or write tokens into source files.
Use the machine's approved package-registry authentication.
If private dependencies are inaccessible, identify the exact dependency
and continue independent work. Do not invent its exports or API.

ARCHITECTURE
Create a monorepo with:
- apps/storefront: Next.js App Router, TypeScript.
- apps/composition-bff: independently runnable BFF.
- packages/atom-adapters: adapters around the private atom package.
- packages/molecules: reusable combinations of atoms.
- packages/organisms: reusable domain UI blocks.
- packages/composition-renderer: page and surface rendering.
- packages/contracts: language-neutral API/component contracts.
- packages/design-tokens: integration with existing design tokens.

Inspect the private component library before implementing UI. Reuse its
atoms wherever appropriate. Do not duplicate those implementations.
Keep molecules and organisms in this monorepo. Use explicit package
exports, preserve client directives, and avoid bundling duplicate React.

BFF AND DOMAIN OWNERSHIP
The BFF owns composition and journey orchestration.
Domain services own catalog, inventory, cart, pricing, eligibility,
orders and payment rules.

If implementing Node.js, treat it as a replaceable POC implementation.
Define portable OpenAPI and JSON Schema contracts suitable for Java.
Do not make Spring Boot depend on TypeScript packages or React code.

If implementing Spring Boot, separate composition/orchestration from
domain logic with clear interfaces. Document whether domain modules
are in one deployable POC or independently deployed services.

COMPOSITION
Implement a versioned registry containing component IDs, descriptions,
configurable-property schemas and contract versions.

Every registered component must be usable in every template.
Do not introduce per-template component allowlists.

Support:
- Unique component-instance IDs.
- Repeated components with independent props and data.
- Main, sidebar and full-width placement.
- Ordered blocks and audience rules.
- Per-component data resolvers.
- Component-level errors and missing-context states.
- Validation of configuration and resolved responses.
- Explicit, trusted component imports; no generated executable code.

A business composer must support:
- Create a new /wireless/... page.
- Choose layout/template.
- Add, remove, reorder and configure registered blocks.
- Configure drawer surfaces and supported flow outcomes.
- Save draft, preview and publish.
- Revision conflict handling.
- Separate draft and published definitions.

Publishing an existing registered block or a new page must not require
a frontend rebuild. Adding a new React implementation may require one.

WIRELESS JOURNEY
Use fictional branding, devices, prices and payment fixtures.

Implement:
Catalog → device configuration → plan → trade-in → extras →
cart → shipping/payment/agreements → simulated confirmation.

Include:
- Image carousel usable anywhere, including checkout.
- A new configured page demonstrating repeated carousel instances.
- Quick-cart drawer after successful device selection.
- A flow that skips the drawer and navigates directly.
- Mini-cart summary on subsequent steps.
- Details drawer showing monthly charges, due-today charges,
  discounts and relevant disclosures.

ACTION AND SURFACE PROTOCOL
Buttons trigger approved named actions rather than embedding
flow-specific business conditions throughout React components.

The BFF validates the action, executes domain work, then returns:
- Authoritative cart/quote snapshot and version.
- A validated effect such as openSurface or navigate.
- Composed surface blocks when applicable.

Reuse one accessible drawer host.
Implement focus handling, Escape dismissal, focus restoration,
scroll locking, loading states and recoverable errors.

Prevent duplicate submissions and stale responses.
Use durable idempotency and optimistic concurrency for persisted
mutations, or clearly document the limitations of a demo substitute.
Never automatically retry a non-idempotent transaction.

STATE AND RENDERING
Retain TanStack Query. Do not introduce Redux or Zustand.
Use local state for transient UI and form drafts.

Keep React Compiler and Cache Components enabled.
Place request-dependent reads beneath Suspense.
Do not use force-dynamic/revalidate workarounds incompatible with the
installed Cache Components configuration.

No cross-request server response/data caches.
Request-scoped deduplication is allowed.
Personalized requests and responses must use no-store.
Build artifacts and static application assets may be cached.

Use request-scoped server QueryClients where hydration is needed.
Never create a server-global user-state store.

Provide an authorized server-cart read and SSR hydration if a working
auth/session integration exists. Otherwise use an explicit demo session
adapter and document that it is not production authentication.
Browser sessionStorage alone does not satisfy server-state access.

Keep server credentials out of browser props, query keys and logs.
Expose only a sanitized, read-only development state inspector.

PERFORMANCE
Avoid an eager client registry importing every heavyweight component.
Use explicit lazy imports for suitable interactive blocks.
Preserve server-compatible presentation components and focused
client boundaries. Do not put "use client" at the package root.
Measure emitted bundles and browser requests; do not claim a
performance improvement without evidence.

TESTING
Prefer Vitest and Testing Library for a new repository.
Preserve established test tooling when adapting existing source.

Cover:
- Registry and response contracts.
- Unrestricted placement and repeated instances.
- New page publication without rebuilding.
- Draft/published isolation and revision conflicts.
- Component data failures.
- Quote tampering and required agreements.
- Quick-cart versus navigation outcomes.
- Summary/detail consistency.
- Session isolation and mutation retries.
- Drawer keyboard behavior.
- SSR/hydration and production-mode journeys.

Use the approved browser-testing tools available in this environment.
Report which checks ran and which remain unverified.

DOCUMENTATION AND DEVELOPER GUIDANCE
Create or update:
- Root setup guide.
- Dedicated BFF setup guide.
- Architecture diagrams.
- Private atom integration guide.
- Registry/component authoring guide.
- Page/surface/flow authoring guide.
- State, SSR and caching guide.
- Testing and troubleshooting guide.
- Short AGENTS.md and a reusable implementation skill.

Distinguish implemented functionality from proposed production work.
Do not claim a working AI concierge simply because components are
reusable; document the future client-safe component/action integration.

DELIVERY
Complete the runnable vertical slice, not only scaffolding.
Run relevant tests, type checks and production builds.
Provide exact commands to run each app, demo routes, test results,
known limitations and a clean source package excluding credentials,
dependencies, build output and runtime customer/cart data.
