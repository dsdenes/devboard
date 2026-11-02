# Zalando RESTful API Guidelines — REST rule set

Source: Zalando RESTful API and Event Guidelines
- Canonical edition: https://opensource.zalando.com/restful-api-guidelines/
- Version covered: Last updated 2026-09-29
- Scope of this reference: the 15 REST chapters, rules 100-257. Event chapters are out of scope.
- Copyright holder: Zalando SE
- License: CC BY 4.0
- License text: Creative Commons Attribution 4.0, https://creativecommons.org/licenses/by/4.0/

Every rule below is paraphrased, not reproduced: each row restates the rule's intent as a single
directive and keeps only its published numeric identifier and level. Rule titles, identifiers,
levels, and chapter names are quoted from the guideline. Where a paraphrase is ambiguous, where a
rule has exceptions this summary omits, or where the guideline may have moved on, read the
canonical edition at https://opensource.zalando.com/restful-api-guidelines/ — it is the authority.

Rows use the published rule identifier, the published level (MUST, SHOULD, or MAY), and the
directive an implementer follows. Nothing here overrides the guideline text.


## General guidelines

| Rule | Level | Directive |
| --- | --- | --- |
| 100 | MUST | Design and specify every API with OpenAPI before writing its implementation, and review it with peers and client developers early. |
| 101 | MUST | Publish each API specification as one self-contained YAML document under version control, preferring OpenAPI 3.1. |
| 102 | SHOULD | Provide an online API user manual covering purpose, usage examples, error situations, and architectural context. |
| 103 | MUST | Write every API name, description, and documentation artifact in U.S. English. |
| 234 | MUST | Keep each specification self-contained and reference remote content only when it is durable and immutable. |

## Meta information

| Rule | Level | Directive |
| --- | --- | --- |
| 218 | MUST | Provide the required meta information: title, specification version, description, owner contact, API id, and audience. |
| 116 | MUST | Version the API specification document with Semantic Versioning MAJOR.MINOR.PATCH and align incompatible changes with consumers. |
| 215 | MUST | Give each API a globally unique, immutable URN identifier in the API identifier field of its info block. |
| 219 | MUST | Classify each API by audience - component-internal, product-internal, or external - and declare that audience. |
| 223 | MUST | Name hosts, permissions, and events with the functional naming schema so names survive technical and organizational change. |
| 224 | MUST | Derive API hostnames from the functional name under the organization API domain, keeping legacy hostnames for internal APIs only. |

## Security

| Rule | Level | Directive |
| --- | --- | --- |
| 104 | MUST | Protect every endpoint with authentication and authorization declared as an OpenAPI bearer or oauth2 security scheme. |
| 105 | MUST | Assign scopes to endpoints whose data requires authorization and document where no specific permission is needed. |
| 225 | MUST | Name permissions as application id plus access mode, application id plus resource name plus access mode, or the uid pseudo-permission. |

## Data formats

| Rule | Level | Directive |
| --- | --- | --- |
| 238 | MUST | Use the standard OpenAPI formats for dates, times, integers, numbers, and binary data instead of inventing formats. |
| 171 | MUST | Give every number and integer property one of the formats int32, int64, bigint, float, double, or decimal. |
| 169 | MUST | Define date and time properties with the RFC 3339-based formats and emit upper-case T and Z separators. |
| 255 | SHOULD | Choose date-time for exact instants, date for calendar days, and local variants only when the time zone is supplied separately. |
| 127 | SHOULD | Represent durations and time intervals as ISO 8601 and RFC 3339 strings, including open-ended intervals where needed. |
| 170 | MUST | Use ISO 3166-1 alpha-2 for countries, ISO 639-1 and BCP 47 for languages, and ISO 4217 for currencies. |
| 244 | SHOULD | Serve alternative representations through Accept, Accept-Language, and Accept-Encoding content negotiation with standard media types. |
| 144 | SHOULD | Reserve UUIDs for identifiers that must be generated without coordination, and prefer meaningful identifiers otherwise. |

## URLs

| Rule | Level | Directive |
| --- | --- | --- |
| 135 | SHOULD | Expose resources under the root base path and never under /api. |
| 134 | MUST | Pluralize resource collection names and model a singleton as a collection constrained to one element. |
| 228 | MUST | Keep resource identifiers to ASCII letters, digits, and the characters . - _ : / and never allow an empty identifier. |
| 129 | MUST | Write path segments in lower-case kebab-case beginning with a lower-case letter. |
| 136 | MUST | Use normalized paths with no empty segments and no trailing slash, and reject empty identifier values. |
| 141 | MUST | Keep URLs verb-free: express operations with HTTP methods and put only nouns in paths. |
| 138 | MUST | Model actions as resources, such as a lock resource, rather than as verbs in the path. |
| 140 | SHOULD | Design each resource to satisfy most client use cases and support filtering and embedding for the remainder. |
| 142 | MUST | Name resources with domain-specific terms that identify the business object instead of generic names such as items. |
| 139 | SHOULD | Cover a complete business process in one API rather than exposing thin wrappers around storage. |
| 143 | MUST | Address resources and sub-resources with path segments where each segment is itself a valid resource reference. |
| 241 | MAY | Expose a compound key as a resource identifier, keeping its natural slash-separated form in the path. |
| 145 | MAY | Nest a URL only when the sub-resource cannot exist without its parent, and expose independently addressable resources at the top level. |
| 146 | SHOULD | Keep the number of resource types per API small and group only highly related resources. |
| 147 | SHOULD | Nest sub-resources at most three levels deep. |
| 130 | MUST | Write query parameter names in snake_case and never in camelCase. |
| 137 | MUST | Use the conventional query parameters q, sort, fields, embed, cursor, and limit for their standard purposes. |

## JSON payload

| Rule | Level | Directive |
| --- | --- | --- |
| 167 | MUST | Use JSON with a top-level object as the payload interchange format for structured request and response data. |
| 252 | SHOULD | Use one resource schema for reading and writing, marking readOnly and writeOnly properties instead of splitting models. |
| 250 | SHOULD | Keep payloads Unicode-safe and escape characters that downstream non-JSON tools may mishandle. |
| 168 | MAY | Support non-JSON media types only as business-specific standard formats, keeping JSON as the default representation. |
| 172 | SHOULD | Use IANA-registered media types such as application/json and application/problem+json instead of custom types. |
| 120 | SHOULD | Pluralize array property names and keep object property names singular. |
| 118 | MUST | Restrict property names to lower-case ASCII snake_case. |
| 240 | SHOULD | Declare enumeration values as UPPER_SNAKE_CASE strings. |
| 235 | SHOULD | Name date and time properties so their type is recognizable, using the _at suffix for instants. |
| 216 | SHOULD | Define maps with additionalProperties, give them no sibling properties, and document the key semantics. |
| 123 | MUST | Handle an absent and a null optional nullable property in exactly the same way. |
| 122 | MUST | Never type a boolean property as null; use a named enumeration when absence carries meaning. |
| 124 | SHOULD | Represent an empty collection as [] rather than null. |
| 174 | MUST | Use the common field names and semantics for shared concepts such as id, created, and modified. |
| 249 | MUST | Model addresses with the common address fields and their documented semantics. |
| 173 | MUST | Model monetary values with the common money object: a decimal amount plus an ISO 4217 currency code. |

## HTTP requests

| Rule | Level | Directive |
| --- | --- | --- |
| 148 | MUST | Use HTTP methods according to RFC 9110 semantics for reading, creating, replacing, updating, and deleting. |
| 149 | MUST | Preserve the safety, idempotency, and cacheability properties of every HTTP method. |
| 229 | SHOULD | Design POST and PATCH idempotent where duplicate resources or lost updates are possible. |
| 231 | SHOULD | Make POST creation idempotent with a resource-specific secondary key guarded by a server-side uniqueness constraint. |
| 253 | MAY | Support asynchronous request processing for long-running work with a status resource the client can poll. |
| 154 | MUST | Declare whether a collection-valued header or query parameter is comma-separated or repeated. |
| 236 | SHOULD | Express simple queries with query parameters that combine with AND semantics. |
| 237 | SHOULD | Express complex query languages with a JSON request body instead of an ever-growing parameter set. |
| 226 | MUST | Document any implicit response filtering applied for authorization in the API specification. |

## HTTP status codes and errors

| Rule | Level | Directive |
| --- | --- | --- |
| 243 | MUST | Use only official HTTP status codes and use each consistently with its registered semantics. |
| 151 | MUST | Declare every success response and service-specific error response in the API specification. |
| 256 | MUST | Preserve the end-to-end meaning of status codes through sidecars, proxies, gateways, and load balancers. |
| 257 | SHOULD | Interpret a 404 cautiously on the client side, because infrastructure components may produce it. |
| 150 | SHOULD | Prefer the most common HTTP status codes and avoid rarely used ones. |
| 220 | MUST | Return the most specific HTTP status code that describes the outcome. |
| 152 | MUST | Answer batch and bulk requests with 207 while no non-item-specific failure applies. |
| 153 | MUST | Signal rate limiting with 429 and a header that states how long the client should wait. |
| 176 | MUST | Return failures as Problem JSON with application/problem+json for both 4xx and 5xx responses. |
| 177 | MUST | Never expose stack traces or other implementation internals in error responses. |
| 251 | SHOULD | Avoid redirection codes, migrating clients or redirecting in infrastructure instead. |

## HTTP headers

| Rule | Level | Directive |
| --- | --- | --- |
| 133 | MAY | Use standard HTTP headers and declare every supported header in the API specification. |
| 132 | SHOULD | Write header names in kebab-case with upper-case words, except established abbreviations such as ID. |
| 178 | MUST | Use Content-* headers only for describing the message body. |
| 180 | SHOULD | Use the Location header rather than Content-Location to point clients at a resource. |
| 179 | MAY | Use Content-Location to signal the actual location of the representation returned. |
| 181 | MAY | Support the Prefer header for processing preferences instead of proprietary headers. |
| 182 | MAY | Support ETag with If-Match or If-None-Match to expose conflicts and prevent lost updates. |
| 230 | MAY | Support the Idempotency-Key header so a retried request executes only once. |
| 183 | SHOULD | Avoid proprietary headers and, when unavoidable, use only the organization's specified set. |
| 184 | MUST | Propagate proprietary end-to-end headers down the call chain with unchanged names and values. |
| 233 | MUST | Accept and pass on the X-Flow-ID header so call flows can be correlated. |

## Hypermedia

| Rule | Level | Directive |
| --- | --- | --- |
| 162 | MUST | Implement REST maturity level 2 with resources, HTTP methods, and status codes. |
| 163 | MAY | Adopt HATEOAS level 3 only where its added complexity pays for itself. |
| 164 | MUST | Represent links to other resources with the common hypertext control object carrying an href. |
| 165 | SHOULD | Use simple href links with the standard link relations for pagination and self-references. |
| 217 | MUST | Write links as full absolute URIs, using the same host where applicable. |
| 166 | MUST | Embed links in the JSON payload and never use the Link header with JSON entities. |

## Performance

| Rule | Level | Directive |
| --- | --- | --- |
| 155 | SHOULD | Support compression, field filtering, and embedding to reduce bandwidth and improve responsiveness. |
| 156 | SHOULD | Support gzip content encoding and negotiate it through Accept-Encoding, keeping unencoded responses available. |
| 157 | SHOULD | Allow clients to select a subset of fields with the fields query parameter. |
| 158 | SHOULD | Allow clients to request embedded sub-resources with the embed query parameter. |
| 227 | MUST | Document the caching behavior of every cacheable GET, HEAD, and POST endpoint. |

## Pagination

| Rule | Level | Directive |
| --- | --- | --- |
| 159 | MUST | Paginate every list that can grow beyond a few hundred entries. |
| 160 | SHOULD | Prefer cursor-based pagination and avoid offset-based pagination. |
| 248 | SHOULD | Return a pagination page object with self, first, prev, next, and last. |
| 161 | SHOULD | Provide standard pagination links as simplified hypertext controls. |
| 254 | SHOULD | Avoid returning a total result count unless clients genuinely require it. |

## Compatibility

| Rule | Level | Directive |
| --- | --- | --- |
| 106 | MUST | Change APIs only in ways that keep every existing consumer running. |
| 107 | SHOULD | Evolve APIs through compatible extensions: add optional fields, relax constraints, and never change field semantics. |
| 109 | SHOULD | Be conservative in what you accept: reject unknown input fields with 400 and document any deliberate exception. |
| 108 | MUST | Make clients tolerant readers that ignore unknown response fields and accept compatible extensions. |
| 111 | MUST | Treat OpenAPI object definitions as open for extension by default, even without an additionalProperties declaration. |
| 113 | SHOULD | Avoid new API versions; prefer a resource variant, a new service, or a parallel version only when unavoidable. |
| 114 | MUST | Version APIs through media types and content negotiation, for example a version parameter on the media type. |
| 115 | MUST | Never put a version number in the URL path. |
| 110 | MUST | Return a JSON object, never an array or a map, as the top-level response structure. |
| 112 | SHOULD | Use enum only for values you fully control and declare an open-ended list of values otherwise. |

## Deprecation

| Rule | Level | Directive |
| --- | --- | --- |
| 187 | MUST | Mark deprecated elements in the specification with deprecated true, a sunset date, and migration guidance. |
| 185 | MUST | Obtain client consent on a sunset date before shutting down an API, an API version, or an API feature. |
| 186 | MUST | Collect external partner consent on the post-deprecation support time span before they use the API. |
| 188 | MUST | Monitor usage of a deprecated API, version, or feature scheduled for sunset. |
| 189 | SHOULD | Send Deprecation and, when planned, Sunset headers on responses affected by a deprecation. |
| 190 | SHOULD | Monitor Deprecation and Sunset headers as a client and alert on them. |
| 191 | MUST | Never start using a deprecated API, API version, or API feature. |

## API operation

| Rule | Level | Directive |
| --- | --- | --- |
| 192 | MUST | Publish the OpenAPI specification of every external API with the service deployment. |
| 193 | SHOULD | Monitor API usage per client to know who depends on the API. |
