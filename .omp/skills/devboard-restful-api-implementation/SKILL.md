---
name: devboard-restful-api-implementation
description: Apply Zalando's RESTful API Guidelines when designing, specifying, or implementing an HTTP API - resources, URLs, JSON payloads, HTTP methods, status codes, headers, hypermedia, performance, pagination, compatibility, and deprecation. Use when writing or reviewing an API specification or API code.
---

# RESTful API Implementation

Design and implementation policy for HTTP APIs, taken from Zalando's RESTful API Guidelines at
https://opensource.zalando.com/restful-api-guidelines/.

The chapters below restate the guideline's REST chapters as directives, and the bundled rule
reference at `skill://devboard-restful-api-implementation/references/zalando-rest-rules.md` carries one row
per published rule with its identifier and level. This skill is a working summary, not the source:

- Read https://opensource.zalando.com/restful-api-guidelines/ whenever a rule is not restated here,
  whenever an exception may apply, or whenever the guideline may have moved on; that page is the
  authority for every question this skill leaves open.
- Apply a rule at the level it is published with: `MUST` is binding, `SHOULD` yields only to a
  stated reason, `MAY` is an allowed option that needs no justification.
- Treat the event chapters of the guideline as out of scope; this skill covers the REST chapters
  only.

## General guidelines

- Design and specify every API with OpenAPI before its implementation, and obtain peer and client
  review early (rules 100, 101).
- Keep each specification one self-contained YAML document under version control, and reference
  remote content only when it is durable and immutable (rule 234).
- Provide an online user manual covering purpose, usage examples, error situations, and
  architectural context (rule 102).
- Write API names, descriptions, and documentation in U.S. English (rule 103).

## Meta information

- Provide title, specification version, description, owner contact, API identifier, and audience in
  the specification's meta information (rule 218).
- Version the specification document with Semantic Versioning MAJOR.MINOR.PATCH (rule 116).
- Give each API a globally unique, immutable identifier and declare its intended audience
  (rules 215, 219).
- Name hosts, permissions, and events with the functional naming schema so names outlive technical
  and organizational change (rules 223, 224).

## Security

- Protect every endpoint with authentication and authorization, declared as an OpenAPI bearer or
  oauth2 security scheme (rule 104).
- Assign scopes to endpoints whose data requires authorization, name them by application id and
  access mode, and document endpoints that need no specific permission (rules 105, 225).

## Data formats

- Use the standard formats for dates, times, integers, numbers, binary data, countries, languages,
  currencies, durations, and intervals (rules 238, 169, 170, 127).
- Give every number and integer property an explicit format so a client never guesses precision
  (rule 171).
- Choose date-time for exact instants, date for calendar days, and local variants only with a
  separate time zone (rule 255).
- Negotiate alternative representations through Accept, Accept-Language, and Accept-Encoding with
  standard media types (rule 244).
- Reserve UUIDs for identifiers that must be generated without coordination, and prefer meaningful
  identifiers otherwise (rule 144).

## URLs

- Pluralize collection names, write path segments in lower-case kebab-case, and keep URLs verb-free
  (rules 134, 129, 141).
- Model actions as resources and name resources with domain-specific terms rather than generic ones
  (rules 138, 142).
- Expose resources under the root base path, normalize paths, and never use an `/api` prefix or a
  trailing slash (rules 135, 136).
- Address resources and sub-resources with meaningful path segments, nest only when a child cannot
  exist without its parent, and stay within three sub-resource levels (rules 143, 145, 147).
- Write query parameter names in snake_case and use the conventional `q`, `sort`, `fields`, `embed`,
  `cursor`, and `limit` parameters for their standard purposes (rules 130, 137).

## JSON payload

- Use JSON with a top-level object, snake_case property names, pluralized array names, and singular
  object names (rules 167, 118, 120).
- Declare enumeration values as UPPER_SNAKE_CASE strings and use `enum` only for values you fully
  control (rules 240, 112).
- Handle absent and null properties identically, never type a boolean as null, and represent an
  empty collection as `[]` (rules 123, 122, 124).
- Reuse the common field names and semantics, the common address fields, and the common money
  object (rules 174, 249, 173).

## HTTP requests

- Use HTTP methods according to RFC 9110 and preserve the safety, idempotency, and cacheability of
  each method (rules 148, 149).
- Design POST and PATCH idempotent where duplicate resources or lost updates are possible, using a
  resource-specific secondary key for creation (rules 229, 231).
- Declare whether collection-valued headers and query parameters are comma-separated or repeated,
  and document any implicit response filtering (rules 154, 226).

## HTTP status codes and errors

- Use only official status codes, return the most specific one, and declare every success and
  service-specific error response (rules 243, 220, 151).
- Return Problem JSON as `application/problem+json` for 4xx and 5xx failures, and never expose stack
  traces or implementation internals (rules 176, 177).
- Answer batch and bulk requests with 207 and rate limiting with 429 plus a header stating how long
  to wait (rules 152, 153).

## HTTP headers

- Write header names in kebab-case with upper-case words and use `Content-*` headers only for the
  message body (rules 132, 178).
- Prefer `Location` over `Content-Location`, and support `Prefer`, `ETag` with `If-Match`, and
  `Idempotency-Key` where they remove ambiguity for clients (rules 180, 181, 182, 230).
- Avoid proprietary headers, propagate the end-to-end ones unchanged, and pass on `X-Flow-ID`
  (rules 183, 184, 233).

## Hypermedia

- Implement REST maturity level 2 and add HATEOAS level 3 only where its complexity pays for itself
  (rules 162, 163).
- Represent links with the common hypertext control, always as full absolute URIs, and embed them in
  the JSON payload instead of a `Link` header (rules 164, 217, 166).

## Performance

- Support gzip content encoding and negotiate it through `Accept-Encoding` (rule 156).
- Let clients reduce payloads with field filtering and optional sub-resource embedding
  (rules 157, 158).
- Document the caching behavior of every cacheable GET, HEAD, and POST endpoint (rule 227).

## Pagination

- Paginate every list that can grow beyond a few hundred entries, preferring cursor-based over
  offset-based pagination (rules 159, 160).
- Return a page object with `self`, `first`, `prev`, `next`, and `last` links, and avoid a total
  result count unless clients genuinely need it (rules 248, 161, 254).

## Compatibility

- Change APIs only compatibly: add optional fields, relax constraints, and never change the meaning
  of a field (rules 106, 107).
- Reject unknown input fields with 400 unless a documented policy says otherwise, and make clients
  tolerant readers that ignore unknown response fields (rules 109, 108).
- Return a JSON object at the top level and treat object definitions as open for extension by
  default (rules 110, 111).
- Avoid versioning; when it is unavoidable, version through media types and never through a version
  number in the URL path (rules 113, 114, 115).

## Deprecation

- Mark deprecated elements in the specification with `deprecated: true`, a sunset date when one is
  planned, and migration guidance (rule 187).
- Obtain client consent on the sunset date, collect external partner consent on the support time
  span, monitor usage of the deprecated element, and never start using a deprecated API
  (rules 185, 186, 188, 191).
- Send `Deprecation` and `Sunset` headers on affected responses and monitor them as a client
  (rules 189, 190).

## API operation

- Publish the OpenAPI specification of every external API with the deployment of its service
  (rule 192).
- Monitor API usage per client so that API owners know who depends on what (rule 193).
