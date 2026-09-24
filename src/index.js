/**
 * Cloudflare Worker shim that translates a subset of the SimpleLogin API into
 * the ProxiedMail API surface expected by client applications.
 *
 * The worker accepts SimpleLogin-style routes such as /api/auth/login,
 * /api/v2/aliases, and /api/setting, then forwards the work to the upstream
 * ProxiedMail service while re-shaping the response payloads to match the
 * SimpleLogin format the client already knows.
 */
import NameModel from './name_model.json'

/**
 * Standard empty envelope used for unhandled or unsupported routes.
 */
const EMPTY_RESPONSE = { error: null, data: [] }

/**
 * Worker entry point exported to Cloudflare.
 * It finds the matching route, executes it, and converts thrown errors into
 * JSON responses so the shim behaves like a stable SimpleLogin-compatible API.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const route = matchRoute(request.method, url.pathname)

    // A request is accepted only if the verb + pathname matches one of the shim's
    // explicit handler routes. Any other path is deliberately treated as an empty
    // success envelope instead of passing through to the upstream API, because the
    // client expects a stable SimpleLogin-compatible surface even for unknown routes.
    if (!route) {
      return json(EMPTY_RESPONSE, 200)
    }

    try {
      return await route.handler(request, env, url, route.params)
    }
    catch (error) {
      // Preserve HTTP status information from upstream errors when we already have a
      // typed HttpError; otherwise collapse everything into a generic 500. This is
      // the decision point that keeps the shim usable for a client that expects JSON
      // errors instead of a raw exception.
      if (error instanceof HttpError) {
        return json(error.body, error.status)
      }

      return json(
        {
          error: error instanceof Error ? error.message : 'Unexpected error',
        },
        500,
      )
    }
  },
}

/**
 * Ordered list of API routes that this shim intentionally supports.
 * Each route maps an HTTP verb and path regex to a handler that implements the
 * SimpleLogin-compatible behavior for that endpoint.
 */
const routes = [
  { method: 'GET', pattern: /^\/$/, handler: handleRoot },
  { method: 'POST', pattern: /^\/api\/auth\/login$/, handler: handleAuthLogin },
  { method: 'GET', pattern: /^\/api\/user_info$/, handler: handleRoot },
  { method: 'GET', pattern: /^\/api\/setting$/, handler: handleSetting },
  { method: 'PATCH', pattern: /^\/api\/setting$/, handler: handleSettingUpdate },
  { method: 'GET', pattern: /^\/api\/v2\/setting\/domains$/, handler: handleSettingDomainsList },
  { method: 'GET', pattern: /^\/api\/custom_domains$/, handler: handleCustomDomainsList },
  { method: 'GET', pattern: /^\/api\/v5\/alias\/options$/, handler: handleAliasOptions },
  { method: 'GET', pattern: /^\/api\/v2\/aliases$/, handler: handleAliasesList },
  { method: 'GET', pattern: /^\/api\/v2\/mailboxes$/, handler: handleMailboxesList },
  { method: 'POST', pattern: /^\/api\/v2\/aliases$/, handler: handleAliasesList },
  { method: 'PATCH', pattern: /^\/api\/aliases\/([^/]+)$/, handler: handleAliasUpdate },
  { method: 'PUT', pattern: /^\/api\/aliases\/([^/]+)$/, handler: handleAliasUpdate },
  { method: 'GET', pattern: /^\/api\/aliases\/([^/]+)\/activities$/, handler: handleAliasActivities },
  { method: 'GET', pattern: /^\/api\/aliases\/([^/]+)\/contacts$/, handler: handleAliasContactsList },
  { method: 'POST', pattern: /^\/api\/aliases\/([^/]+)\/contacts$/, handler: handleAliasContactCreate },
  { method: 'POST', pattern: /^\/api\/alias\/random\/new$/, handler: handleRandomAliasCreate },
  { method: 'POST', pattern: /^\/api\/v3\/alias\/custom\/new$/, handler: handleCustomAliasCreate },
  { method: 'POST', pattern: /^\/api\/aliases\/([^/]+)\/toggle$/, handler: handleAliasToggle },
  { method: 'DELETE', pattern: /^\/api\/aliases\/([^/]+)$/, handler: handleAliasDelete },
]

/**
 * Matches an incoming request against the supported route table.
 *
 * @param {string} method - HTTP verb from the incoming request.
 * @param {string} pathname - URL pathname to match against known routes.
 * @returns {{ method: string, pattern: RegExp, handler: Function, params: string[] } | null}
 */
function matchRoute(method, pathname) {
  // The actual decision is "do we support this verb+path pair?" If the method does
  // not match, we skip the route immediately. If the regex matches, we capture the
  // path parameters and hand execution to the corresponding compatibility handler;
  // otherwise no route is returned and the worker returns an empty envelope.
  for (const route of routes) {
    if (route.method !== method) {
      continue
    }

    const match = pathname.match(route.pattern)
    if (match) {
      console.log(`Matched route: ${method} ${route.pattern}`)
      return { ...route, params: match.slice(1) }
    }
  }

  return null
}

/**
 * Returns the authenticated user profile in the SimpleLogin shape expected by the
 * client app. This is a lightweight compatibility projection over
 * ProxiedMail's /api/v1/users/me payload.
 */
async function handleRoot(request, env) {
  // This is the SimpleLogin /api/user_info and / root profile read. The client
  // expects a flat object, but ProxiedMail gives a nested response under
  // body.data.attributes and body.meta.plan. We copy only the fields the client
  // actually reads: username -> name, email -> email, plan.isPaid -> is_premium,
  // maxFreeProxyBindings -> max_alias_free_plan, and then fill the rest with
  // SimpleLogin-compatible defaults like in_trial: false and profile_picture_url: null.
  const profile = await proxiedmailFetchOrThrow(request, env, '/api/v1/users/me?updateFrontCache=0', {
    authMode: 'token',
  })
  const body = await profile.json()
  const isPremium = Boolean(body?.meta?.plan?.isPaid)

  return json({
    name: body?.data?.attributes?.username ?? '',
    is_premium: isPremium,
    email: body?.data?.attributes?.email ?? '',
    in_trial: false,
    trial_end_timestamp: null,
    profile_picture_url: null,
    max_alias_free_plan: body?.meta?.maxFreeProxyBindings ?? null,
    connected_proton_address: null,
    can_create_reverse_alias: true,
  })
}

/**
 * Implements the SimpleLogin login endpoint by exchanging the caller's email and
 * password against ProxiedMail's auth service, then fetching the user profile and
 * an API token to return a SimpleLogin-style payload.
 */
async function handleAuthLogin(request, env) {
  // SimpleLogin clients send { email, password } in the request body, while
  // ProxiedMail expects a nested auth request under data.attributes.username and
  // data.attributes.password. We unwrap the SimpleLogin payload, call ProxiedMail's
  // /api/v1/auth, then immediately request both a new API token and the current
  // user profile. The final response is flattened back into the SimpleLogin shape:
  // username/email are taken from the profile and api_key is the token returned by
  // the ProxiedMail API token endpoint.
  const payload = await readJsonBody(request)
  const email = String(payload?.email ?? '').trim()
  const password = String(payload?.password ?? '')

  if (!email || !password) {
    return json({ error: 'Email or password incorrect' }, 400)
  }

  const authResponse = await fetch(`${String(env.PROXIEDMAIL_BASE_URL || 'https://proxiedmail.com').replace(/\/$/, '')}/api/v1/auth`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      data: {
        type: 'auth-request',
        attributes: {
          username: email,
          password,
        },
      },
    }),
  })

  if (!authResponse.ok) {
    return json({ error: 'Email or password incorrect' }, authResponse.status >= 400 && authResponse.status < 500 ? 400 : authResponse.status)
  }

  const authBody = await authResponse.json()
  const bearerToken = authBody?.data?.attributes?.token
  if (!bearerToken) {
    return json({ error: 'Email or password incorrect' }, 400)
  }

  const [apiTokenResponse, profileResponse] = await Promise.all([
    fetch(`${String(env.PROXIEDMAIL_BASE_URL || 'https://proxiedmail.com').replace(/\/$/, '')}/api/v1/api-token`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${bearerToken}`,
      },
    }),
    fetch(`${String(env.PROXIEDMAIL_BASE_URL || 'https://proxiedmail.com').replace(/\/$/, '')}/api/v1/users/me?updateFrontCache=0`, {
      headers: {
        Accept: 'application/json',
        Token: bearerToken,
      },
    }),
  ])

  if (!apiTokenResponse.ok) {
    return relayError(apiTokenResponse)
  }

  const apiTokenBody = await apiTokenResponse.json()
  const profileBody = profileResponse.ok ? await profileResponse.json() : null

  return json({
    name: profileBody?.data?.attributes?.username ?? '',
    email: profileBody?.data?.attributes?.email ?? email,
    mfa_enabled: false,
    mfa_key: '',
    api_key: apiTokenBody?.token ?? '',
  })
}

/**
 * Lists alias-generation options and supported domains in the SimpleLogin
 * structure. It merges ProxiedMail's available domains and custom domains into
 * a single deduplicated suffix list.
 */
async function handleAliasOptions(request, env, url) {
  // This endpoint answers the alias creation UI with the list of suffixes and
  // whether the account can create more aliases. The frontend is expecting a
  // SimpleLogin payload shaped like { can_create, suffixes, prefix_suggestion },
  // but ProxiedMail exposes available domains and custom domains in separate
  // endpoints. We pull both together, normalize each domain into @example.com
  // entries, deduplicate custom-vs-default conflicts, and then expose the result as
  // the SL suffix list that the UI expects.
  const [domainsResponse, customDomainsResponse, aliasesResponse] = await Promise.all([
    proxiedmailFetchOrThrow(request, env, '/gapi/available-domains', { authMode: 'bearer' }),
    proxiedmailFetchOrThrow(request, env, '/gapi/custom-domains?ignoreProcessing=1', { authMode: 'bearer' }),
    proxiedmailFetchOrThrow(request, env, '/api/v1/proxy-bindings?sort=desc', { authMode: 'token' }),
  ])

  const [domainsBody, customDomainsBody, aliasesBody] = await Promise.all([
    domainsResponse.json(),
    customDomainsResponse.json(),
    aliasesResponse.json(),
  ])

  const suffixes = dedupeSuffixEntries([
    ...normalizeAvailableDomains(domainsBody),
    ...normalizeCustomDomains(customDomainsBody),
  ])

  return json({
    can_create: (aliasesBody?.meta?.availableProxyBindings ?? 0) > 0,
    suffixes,
    prefix_suggestion: hostnameSuggestion(url.searchParams.get('hostname')),
    recommendation: null,
  })
}

/**
 * Lists the domains allowed for alias configuration, normalized to the shape
 * SimpleLogin expects for the /api/v2/setting/domains endpoint.
 */
async function handleSettingDomainsList(request, env) {
  // The SimpleLogin UI asks for a flat domain list under /api/v2/setting/domains,
  // but ProxiedMail stores the same data in two different endpoints: built-ins and
  // custom domains. This function fetches both sets, strips the leading @ from the
  // normalized suffix values, and converts the result to { domain, is_custom }
  // entries. Those are then de-duped so the client sees a single clean list.
  const [domainsResponse, customDomainsResponse] = await Promise.all([
    proxiedmailFetchOrThrow(request, env, '/gapi/available-domains', { authMode: 'bearer' }),
    proxiedmailFetchOrThrow(request, env, '/gapi/custom-domains?ignoreProcessing=1', { authMode: 'bearer' }),
  ])
  const [domainsBody, customDomainsBody] = await Promise.all([
    domainsResponse.json(),
    customDomainsResponse.json(),
  ])

  const domains = dedupeSettingDomains([
    ...normalizeAvailableDomains(domainsBody).map(entry => ({ domain: entry.suffix.slice(1), is_custom: false })),
    ...normalizeCustomDomains(customDomainsBody).map(entry => ({ domain: entry.suffix.slice(1), is_custom: true })),
  ])

  return json(domains)
}

/**
 * Lists only the custom domains configured on the account, in the SimpleLogin
 * /api/custom_domains shape, including the current alias count per domain.
 */
async function handleCustomDomainsList(request, env) {
  // Unlike /api/v2/setting/domains, this endpoint must only report custom domains
  // (not ProxiedMail's built-in ones), so we skip the available-domains fetch
  // entirely and just enrich each custom domain with its live alias count.
  const [customDomainsResponse, bindingsResponse] = await Promise.all([
    proxiedmailFetchOrThrow(request, env, '/gapi/custom-domains?ignoreProcessing=1', { authMode: 'bearer' }),
    proxiedmailFetchOrThrow(request, env, '/api/v1/proxy-bindings?sort=desc', { authMode: 'token' }),
  ])
  const [customDomainsBody, bindingsBody] = await Promise.all([
    customDomainsResponse.json(),
    bindingsResponse.json(),
  ])

  const customDomains = Array.isArray(customDomainsBody)
    ? customDomainsBody.map(entry => {
      const domainName = String(entry?.domain_name ?? entry?.domain ?? '').trim().toLowerCase()
      const domainBindings = (Array.isArray(bindingsBody?.data) ? bindingsBody.data : [])
        .filter(binding => getBindingDomain(binding) === domainName)
      const mailboxes = dedupeMailboxEmails(domainBindings.flatMap(binding => (
        normalizeRealAddresses(binding?.attributes?.real_addresses).map(address => address.email)
      ))).map((email, index) => ({
        id: toSimpleLoginMailboxId(email, index),
        email,
      }))

      return {
        id: toSimpleLoginAliasId(entry?.id ?? domainName),
        creation_timestamp: toUnixTimestamp(entry?.createdAt ?? entry?.created_at),
        domain_name: domainName,
        name: null,
        // Upstream does not expose a reliable verification flag for custom domains.
        is_verified: true,
        nb_alias: domainBindings.length,
        random_prefix_generation: false,
        mailboxes,
        catch_all: typeof entry?.catch_all === 'boolean'
          ? entry.catch_all
          : typeof entry?.catchAll === 'boolean' ? entry.catchAll : false,
      }
    })
    : []

  return json({ custom_domains: customDomains })
}

/**
 * Reads a bundle of account settings from ProxiedMail and reshapes it into the
 * SimpleLogin setting payload used by clients.
 */
async function handleSetting(request, env) {
  // SimpleLogin reads a compact settings object. ProxiedMail stores settings as a
  // list of { key, value } records under /gapi/settings and separately exposes the
  // available domains. We re-map the underlying values into the names the client
  // expects: random_alias_default_domain, sender_format, and random_alias_suffix.
  const settings = await listProxiedmailSettings(request, env)
  const domains = await handleSettingDomainsData(request, env)

  return json({
    notification: true,
    alias_generator: 'word',
    random_alias_default_domain: settings.get('random_alias_default_domain') ?? domains[0]?.domain ?? '',
    sender_format: settings.get('sender_format') ?? 'AT',
    random_alias_suffix: normalizeRandomAliasSuffix(settings.get('random_alias_suffix')),
  })
}

/**
 * Updates a subset of user settings on ProxiedMail and returns the refreshed
 * settings payload in SimpleLogin format.
 */
async function handleSettingUpdate(request, env) {
  // Decision point: which SimpleLogin settings are even supported by this shim?
  // Only the three keys the UI writes are mapped; everything else is ignored. That
  // keeps the patch payload minimal and avoids accidentally mutating upstream values
  // the shim does not understand.
  const payload = await readJsonBody(request)
  const nextSettings = []

  if (Object.prototype.hasOwnProperty.call(payload, 'random_alias_default_domain')) {
    nextSettings.push({
      key: 'random_alias_default_domain',
      value: String(payload.random_alias_default_domain ?? ''),
    })
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'sender_format')) {
    nextSettings.push({
      key: 'sender_format',
      value: String(payload.sender_format ?? 'AT'),
    })
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'random_alias_suffix')) {
    const suffix = normalizeRandomAliasSuffix(payload.random_alias_suffix)
    nextSettings.push({
      key: 'random_alias_suffix',
      value: suffix,
    })
  }

  // If the client sent no supported fields, we intentionally make no upstream call and
  // just return the current settings for the current account.
  if (nextSettings.length > 0) {
    const response = await proxiedmailFetch(request, env, '/gapi/settings/update', {
      authMode: 'bearer',
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ settings: nextSettings }),
    })

    if (!response.ok) {
      return relayError(response)
    }
  }

  return handleSetting(request, env)
}

/**
 * Lists aliases with a SimpleLogin response envelope, supporting pagination,
 * filtering, and sorting based on the request query parameters.
 */
async function handleAliasesList(request, env, url) {
  // This is the page/filter decision point: without page_id the client cannot page
  // legitimately, so we reject early. Once page_id exists, the list is mapped to the
  // SimpleLogin alias schema, filtered by enabled/disabled/pinned, then sliced to a
  // fixed page size of 20 before returning the final { aliases } envelope.
  if (!url.searchParams.has('page_id')) {
    return json({ error: 'page_id must be provided in request query' }, 400)
  }

  const pageId = Math.max(Number.parseInt(url.searchParams.get('page_id') ?? '0', 10) || 0, 0)
  const response = await proxiedmailFetchOrThrow(request, env, `/api/v1/proxy-bindings${forwardQuery(url.searchParams, ['sort'])}${url.searchParams.has('sort') ? '' : '?sort=desc'}`, {
    authMode: 'token',
  })
  const body = await response.json()
  const aliases = Array.isArray(body?.data)
    ? body.data
      .map(toSimpleLoginAlias)
      .filter(alias => matchesAliasFilter(alias, url.searchParams))
      .slice(pageId * 20, (pageId + 1) * 20)
    : []

  return json({ aliases })
}

/**
 * Lists mailbox records in SimpleLogin format by combining verified addresses,
 * real addresses, and the alias counts associated with each mailbox.
 */
async function handleMailboxesList(request, env) {
  // Mailboxes are the SimpleLogin equivalent of real addresses. ProxiedMail keeps
  // them in two separate sources: /gapi/real-emails and /gapi/verified-emails-list.
  // We merge both lists, de-dupe them, and then enrich each mailbox with metadata
  // the client expects: default status, alias count by real address, and whether the
  // address is verified. The final shape becomes { mailboxes: [{ id, email, default,
  // nb_alias, verified }] }.
  const [realEmailsResponse, verifiedResponse, bindingsResponse] = await Promise.all([
    proxiedmailFetchOrThrow(request, env, '/gapi/real-emails', { authMode: 'bearer' }),
    proxiedmailFetchOrThrow(request, env, '/gapi/verified-emails-list', { authMode: 'bearer' }),
    proxiedmailFetchOrThrow(request, env, '/api/v1/proxy-bindings?sort=desc', { authMode: 'token' }),
  ])
  const [realEmailsBody, verifiedBody, bindingsBody] = await Promise.all([
    realEmailsResponse.json(),
    verifiedResponse.json(),
    bindingsResponse.json(),
  ])

  const realEmails = Array.isArray(realEmailsBody?.data) ? realEmailsBody.data : []
  const verifiedEmails = new Set(Array.isArray(verifiedBody?.List) ? verifiedBody.List.map(email => String(email)) : [])
  const defaultRealAddress = await getDefaultRealAddress(request, env)
  const aliasCounts = countAliasesByRealAddress(Array.isArray(bindingsBody?.data) ? bindingsBody.data : [])

  const mailboxes = dedupeMailboxEmails([
    ...realEmails.map(entry => entry?.email),
    ...verifiedEmails,
  ]).map(email => ({
    id: toSimpleLoginMailboxId(email, 0),
    email,
    default: email === defaultRealAddress,
    creation_timestamp: null,
    nb_alias: aliasCounts.get(email) ?? 0,
    verified: verifiedEmails.has(email),
  }))

  return json({ mailboxes })
}

/**
 * Creates a new random alias by choosing a domain, ensuring a verified mailbox
 * exists, and pushing the binding through the ProxiedMail proxy-binding API.
 */
async function handleRandomAliasCreate(request, env, url) {
  // The creation flow has three important gates: (1) do we have any candidate
  // domains?, (2) do we have a usable default mailbox?, and (3) if the user's
  // default domain is invalid, fall back to the first available domain. Only after
  // those checks pass do we create the ProxiedMail binding and attach the optional
  // note as a description.
  const payload = await readJsonBody(request)
  console.log('Payload received for random alias creation:', payload)
  const [domainOptions, settings] = await Promise.all([
    listCandidateDomains(request, env),
    listProxiedmailSettings(request, env),
  ])
  if (domainOptions.length === 0) {
    return json({ error: 'No domains available' }, 400)
  }

  const realAddress = await getDefaultRealAddress(request, env)
  if (!realAddress) {
    return json({ error: 'No verified mailbox available' }, 400)
  }

  const defaultDomain = settings.get('random_alias_default_domain')
  const selectedDomain = (defaultDomain && domainOptions.find(d => d.domain === defaultDomain))
    ? defaultDomain
    : domainOptions[0].domain
  const proxyAddress = `${buildRandomPrefix(url.searchParams.get('mode'))}@${selectedDomain}`
  const created = await createProxyBinding(request, env, {
    proxy_address: proxyAddress,
    real_addresses: [realAddress],
  })

  let alias = created.data

  if (payload?.note) {
    const updated = await patchProxyBinding(request, env, created.data.id, created.data.attributes.proxy_address, {
      description: String(payload.note),
    })
    alias = updated.data
  }

  return json(toSimpleLoginAlias(alias), 201)
}

/**
 * Creates a custom alias with a user-defined prefix and a signed suffix, then
 * assigns it to the selected mailbox IDs or the default mailbox when omitted.
 */
async function handleCustomAliasCreate(request, env) {
  // Custom creation is stricter than random creation: we require a signed suffix,
  // then validate mailbox selection. If the client gave mailbox_ids we resolve them
  // to real emails; if it omitted them we fall back to the default mailbox; if that
  // mailbox is missing we reject the request instead of creating a broken alias.
  const payload = await readJsonBody(request)
  const signedSuffix = String(payload?.signed_suffix ?? '').trim()
  const aliasPrefix = sanitizeAliasPrefix(payload?.alias_prefix) || buildRandomPrefix('word')
  const domain = normalizeSignedSuffix(signedSuffix)

  if (!domain) {
    return json({ error: 'signed_suffix is required' }, 400)
  }

  const requestedMailboxIds = Array.isArray(payload?.mailbox_ids)
    ? payload.mailbox_ids
    : Object.prototype.hasOwnProperty.call(payload ?? {}, 'mailbox_id')
    ? [payload.mailbox_id]
    : null

  const mailboxEmails = requestedMailboxIds
    ? await resolveMailboxEmailsByIds(request, env, requestedMailboxIds)
    : []

  if (requestedMailboxIds && mailboxEmails.length === 0) {
    return json({ error: 'mailbox_ids must be an array of id' }, 400)
  }

  if (!requestedMailboxIds) {
    const realAddress = await getDefaultRealAddress(request, env)
    if (!realAddress) {
      return json({ error: 'No verified mailbox available' }, 400)
    }

    mailboxEmails.push(realAddress)
  }

  const created = await createProxyBinding(request, env, {
    proxy_address: `${aliasPrefix}@${domain}`,
    real_addresses: mailboxEmails,
  })

  let alias = created.data

  if (payload?.note) {
    const updated = await patchProxyBinding(request, env, created.data.id, created.data.attributes.proxy_address, {
      description: String(payload.note),
    })
    alias = updated.data
  }

  return json(toSimpleLoginAlias(alias), 201)
}

/**
 * Flips the enabled state of an alias by toggling every real address associated
 * with the ProxiedMail binding.
 */
async function handleAliasToggle(request, env, _url, params) {
  // The SimpleLogin toggle endpoint is a boolean flip over an alias, but ProxiedMail
  // stores enabled state on each real email entry inside real_addresses. We resolve
  // the binding, invert the state for every mailbox, and then send an object keyed by
  // email address back to ProxiedMail as the new real_addresses payload.
  const aliasId = params[0]
  const binding = await getProxyBindingById(request, env, aliasId)
  const realAddresses = normalizeRealAddresses(binding.attributes?.real_addresses)
  const hasEnabled = realAddresses.some(entry => entry.is_enabled !== false)
  const nextEnabled = !hasEnabled
  const toggledAddresses = Object.fromEntries(
    realAddresses.map(entry => [entry.email, nextEnabled]),
  )

  await patchProxyBinding(request, env, binding.id, binding.attributes?.proxy_address, {
    real_addresses: toggledAddresses,
  })

  return json({ enabled: nextEnabled })
}

/**
 * Deletes an alias by removing the matching ProxiedMail proxy binding.
 */
async function handleAliasDelete(request, env, _url, params) {
  const aliasId = params[0]
  const binding = await getProxyBindingById(request, env, aliasId)
  const response = await proxiedmailFetch(request, env, `/api/v1/proxy-bindings/${encodeURIComponent(binding.id)}`, {
    authMode: 'token',
    method: 'DELETE',
  })

  if (!response.ok) {
    return relayError(response)
  }

  return json({ deleted: true })
}

/**
 * Updates the metadata and mailbox assignments for an alias while keeping the
 * result in the SimpleLogin alias schema.
 */
async function handleAliasUpdate(request, env, _url, params) {
  // SimpleLogin updates can modify note text and mailbox assignments in one payload.
  // We map note -> description and mailbox_ids -> real_addresses by resolving each
  // SimpleLogin mailbox id back to its email and then constructing the upstream
  // object keyed by email. After patching, we immediately convert the updated
  // ProxiedMail binding back into the SimpleLogin alias schema.
  const aliasId = params[0]
  const binding = await getProxyBindingById(request, env, aliasId)
  const payload = await readJsonBody(request)
  const nextAttributes = {}

  if (Object.prototype.hasOwnProperty.call(payload, 'note')) {
    nextAttributes.description = String(payload.note ?? '')
  }

  const requestedMailboxIds = Array.isArray(payload?.mailbox_ids)
    ? payload.mailbox_ids
    : Object.prototype.hasOwnProperty.call(payload ?? {}, 'mailbox_id')
    ? [payload.mailbox_id]
    : null

  if (requestedMailboxIds) {
    const mailboxEmails = await resolveMailboxEmailsByIds(request, env, requestedMailboxIds)
    if (mailboxEmails.length === 0) {
      return json({ error: 'Invalid mailbox_id' }, 400)
    }

    nextAttributes.real_addresses = Object.fromEntries(
      mailboxEmails.map(email => [email, true]),
    )
  }

  const updated = await patchProxyBinding(
    request,
    env,
    binding.id,
    binding.attributes?.proxy_address,
    nextAttributes,
  )

  return json(toSimpleLoginAlias(updated.data))
}

/**
 * Fetches alias activity entries for a given alias and paginates them into the
 * SimpleLogin activities payload format.
 */
async function handleAliasActivities(request, env, url, params) {
  // SimpleLogin activity logs are a paginated list under { activities }, while
  // ProxiedMail exposes them as received email links for a proxy binding id. We
  // fetch that upstream activity stream, convert each event via toSimpleLoginActivity(),
  // and then page the translated result to match the client's expectations.
  const aliasId = params[0]
  const binding = await getProxyBindingById(request, env, aliasId)

  if (!url.searchParams.has('page_id')) {
    return json({ error: 'page_id must be provided in request query' }, 400)
  }

  const pageId = Math.max(Number.parseInt(url.searchParams.get('page_id') ?? '0', 10) || 0, 0)
  const response = await proxiedmailFetch(
    request,
    env,
    `/api/v1/received-emails-links/${encodeURIComponent(binding.id)}`,
    { authMode: 'token' },
  )

  if (response.status === 403) {
    return json({ activities: [] })
  }

  if (!response.ok) {
    return relayError(response)
  }

  const body = await response.json()
  const activities = Array.isArray(body?.data)
    ? body.data
      .slice(pageId * 20, (pageId + 1) * 20)
      .map(entry => toSimpleLoginActivity(entry, binding.attributes?.proxy_address))
      .filter(Boolean)
    : []

  return json({ activities })
}

/**
 * Lists contacts attached to a given alias and converts them into the SimpleLogin
 * contact schema, supporting pagination.
 */
async function handleAliasContactsList(request, env, url, params) {
  // Contacts are stored on the proxy binding as a nested contacts collection, but
  // the client expects { contacts: [...] } with individual entries in SimpleLogin
  // format. We fetch the upstream collection, convert each document through
  // toSimpleLoginContact(), and page the translated list before returning it.
  const aliasId = params[0]
  const binding = await getProxyBindingById(request, env, aliasId)
  const pageId = Math.max(Number.parseInt(url.searchParams.get('page_id') ?? '0', 10) || 0, 0)
  const response = await proxiedmailFetchOrThrow(
    request,
    env,
    `/api/v1/proxy-bindings/${encodeURIComponent(binding.id)}/contacts`,
    { authMode: 'token' },
  )
  const body = await response.json()
  const contacts = Array.isArray(body?.data)
    ? body.data
      .slice(pageId * 20, (pageId + 1) * 20)
      .map(toSimpleLoginContact)
      .filter(Boolean)
    : []

  return json({ contacts })
}

/**
 * Creates a new contact on an alias, deduplicating contacts that already exist and
 * returning a SimpleLogin-like result payload.
 */
async function handleAliasContactCreate(request, env, _url, params) {
  // SimpleLogin contacts are created by sending a single recipient email, but the
  // upstream ProxiedMail API nests the contact under a relationship to a proxy
  // binding. We first check for an existing contact with the same normalized email,
  // and if none exists we POST a /api/v1/contacts record linking it to the binding.
  // The result is then converted back to the SimpleLogin contact schema with the
  // extra existed flag indicating whether duplicate suppression occurred.
  const aliasId = params[0]
  const binding = await getProxyBindingById(request, env, aliasId)
  const payload = await readJsonBody(request)
  const contact = String(payload?.contact ?? '').trim()

  if (!contact) {
    return json({ error: 'contact is required' }, 400)
  }

  const existingContactsResponse = await proxiedmailFetchOrThrow(
    request,
    env,
    `/api/v1/proxy-bindings/${encodeURIComponent(binding.id)}/contacts`,
    { authMode: 'token' },
  )
  const existingContactsBody = await existingContactsResponse.json()
  const existingContact = Array.isArray(existingContactsBody?.data)
    ? existingContactsBody.data.find(entry => normalizeContactAddress(entry?.attributes?.recipient_email) === normalizeContactAddress(contact))
    : null

  if (existingContact) {
    return json({ ...toSimpleLoginContact(existingContact), existed: true })
  }

  const response = await proxiedmailFetch(request, env, '/api/v1/contacts', {
    authMode: 'token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      data: {
        type: 'proxy_binding_contacts',
        attributes: {
          recipient_email: contact,
        },
        relationships: {
          proxy_binding: {
            data: {
              type: 'proxy_bindings',
              id: String(binding.id),
            },
          },
        },
      },
    }),
  })

  if (!response.ok) {
    return relayError(response)
  }

  const body = await response.json()
  return json({ ...toSimpleLoginContact(body?.data), existed: false }, 201)
}

/**
 * Resolves a ProxiedMail proxy-binding record by its SimpleLogin-style alias ID,
 * accepting either the raw upstream ID or the derived SimpleLogin hash value.
 */
async function getProxyBindingById(request, env, id) {
  // The real compatibility problem is that the client and upstream are using two
  // different identifiers for the same alias: the UI sends a SimpleLogin-style hash,
  // while ProxiedMail exposes the canonical UUID. The resolution logic therefore
  // accepts either raw UUID or derived hash and throws only when neither matches.
  const response = await proxiedmailFetchOrThrow(request, env, `/api/v1/proxy-bindings?sort=desc`, {
    authMode: 'token',
  })
  const body = await response.json()
  const requestedId = String(id)
  const found = Array.isArray(body?.data)
    ? body.data.find(entry => {
      const guid = String(entry?.id ?? '')
      return guid === requestedId || String(toSimpleLoginAliasId(guid)) === requestedId
    })
    : null

  if (!found) {
    throw new Error(`Alias ${id} not found`)
  }

  return found
}

/**
 * Creates a new ProxiedMail proxy binding from a SimpleLogin-compatible payload.
 */
async function createProxyBinding(request, env, attributes) {
  // This is the upstream creation call for a new alias. The shim already has the
  // SimpleLogin-formatted alias data in memory, but ProxiedMail wants the binding
  // wrapped in { data: { type: 'proxy_bindings', attributes } }, with proxy_address
  // and real_addresses as the core fields. The response is returned raw so the
  // caller can then convert it back to the SimpleLogin object shape.
  const response = await proxiedmailFetch(request, env, '/api/v1/proxy-bindings', {
    authMode: 'token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      data: {
        type: 'proxy_bindings',
        attributes,
      },
    }),
  })

  if (!response.ok) {
    throw await errorFromResponse(response)
  }

  return response.json()
}

/**
 * Patches an existing ProxiedMail proxy binding to update note text, mailbox
 * assignments, or enabled state while preserving the required proxy_address.
 */
async function patchProxyBinding(request, env, id, proxyAddress, attributes) {
  // Every alias update is eventually a PATCH against a specific proxy binding.
  // SimpleLogin fields like note, real_addresses, and enabled state must be serialized
  // into ProxiedMail's attribute object, while the required proxy_address field is
  // kept in place so the binding stays coherent even when only some properties changed.
  const response = await proxiedmailFetch(request, env, `/api/v1/proxy-bindings/${encodeURIComponent(id)}`, {
    authMode: 'token',
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      data: {
        id: String(id),
        type: 'proxy_bindings',
        attributes: {
          proxy_address: proxyAddress,
          ...attributes,
        },
      },
    }),
  })

  if (!response.ok) {
    throw await errorFromResponse(response)
  }

  return response.json()
}

/**
 * Collects candidate domains from both ProxiedMail's platform domains and any
 * custom domains, deduplicating them for creation flows.
 */
async function listCandidateDomains(request, env) {
  // The alias UI can only create aliases on domains it considers valid. This helper
  // merges ProxiedMail's built-in domains and custom domains into a single set of
  // candidate domains, stripping the @ prefix and keeping the custom flag so the
  // random alias creator can prefer the configured default domain without duplicates.
  const [domainsResponse, customDomainsResponse] = await Promise.all([
    proxiedmailFetchOrThrow(request, env, '/gapi/available-domains', { authMode: 'bearer' }),
    proxiedmailFetchOrThrow(request, env, '/gapi/custom-domains?ignoreProcessing=1', { authMode: 'bearer' }),
  ])
  const [domainsBody, customDomainsBody] = await Promise.all([
    domainsResponse.json(),
    customDomainsResponse.json(),
  ])

  const domains = [
    ...normalizeAvailableDomains(domainsBody).map(entry => ({ domain: entry.suffix.slice(1), is_custom: entry.is_custom })),
    ...normalizeCustomDomains(customDomainsBody).map(entry => ({ domain: entry.suffix.slice(1), is_custom: entry.is_custom })),
  ]

  return dedupeDomains(domains)
}

/**
 * Chooses the default real address for alias creation, preferring a verified and
 * default mailbox when one exists.
 */
async function getDefaultRealAddress(request, env) {
  // Alias creation requires a mailbox to use as the forwarding target. ProxiedMail
  // exposes the preferred default via real_emails[].is_default and verified status,
  // but the client also accepts a bare verified email if no default is set. We rank
  // those candidates in priority order so alias creation is stable and uses the most
  // suitable mailbox automatically.
  const [verifiedResponse, realEmailsResponse] = await Promise.all([
    proxiedmailFetchOrThrow(request, env, '/gapi/verified-emails-list', { authMode: 'bearer' }),
    proxiedmailFetchOrThrow(request, env, '/gapi/real-emails', { authMode: 'bearer' }),
  ])
  const [verifiedBody, realEmailsBody] = await Promise.all([
    verifiedResponse.json(),
    realEmailsResponse.json(),
  ])

  const verified = Array.isArray(verifiedBody?.List) ? verifiedBody.List : []
  const realEmails = Array.isArray(realEmailsBody?.data) ? realEmailsBody.data : []
  const defaultEntry = realEmails.find(entry => entry?.is_default && entry?.is_verified)

  return defaultEntry?.email ?? verified[0] ?? realEmails.find(entry => entry?.is_verified)?.email ?? null
}

/**
 * Lists all real/verified email addresses and normalizes them into the mailbox
 * identities used by the SimpleLogin client contract.
 */
async function listRealEmails(request, env) {
  // The SimpleLogin mailbox ID is effectively a normalized version of the email
  // address. We gather ProxiedMail's real emails and the verified-email list,
  // dedupe them, and then return objects that look like { id, email, verified,
  // default }. This is what the client uses when resolving mailbox_ids back to
  // actual addresses or displaying the mailbox list.
  const [realEmailsResponse, verifiedResponse] = await Promise.all([
    proxiedmailFetchOrThrow(request, env, '/gapi/real-emails', { authMode: 'bearer' }),
    proxiedmailFetchOrThrow(request, env, '/gapi/verified-emails-list', { authMode: 'bearer' }),
  ])
  const [realEmailsBody, verifiedBody] = await Promise.all([
    realEmailsResponse.json(),
    verifiedResponse.json(),
  ])

  const verifiedEmails = new Set(Array.isArray(verifiedBody?.List) ? verifiedBody.List.map(email => String(email)) : [])
  const realEmails = Array.isArray(realEmailsBody?.data) ? realEmailsBody.data : []

  return dedupeMailboxEmails([
    ...realEmails.map(entry => entry?.email),
    ...verifiedEmails,
  ]).map(email => ({
    id: toSimpleLoginMailboxId(email, 0),
    email,
    verified: verifiedEmails.has(email),
    default: Boolean(realEmails.find(entry => entry?.email === email)?.is_default),
  }))
}

/**
 * Reads the raw user settings object from ProxiedMail and converts it into a Map
 * keyed by setting name for easier lookups.
 */
async function listProxiedmailSettings(request, env) {
  // ProxiedMail stores settings as an array of { key, value } entries. We convert
  // that structure into a Map so the rest of the shim can look up values by name in
  // O(1) time when preparing the SimpleLogin setting response or writing updates.
  const response = await proxiedmailFetchOrThrow(request, env, '/gapi/settings', { authMode: 'bearer' })
  const body = await response.json()
  const entries = Array.isArray(body) ? body : []

  return new Map(
    entries
      .filter(entry => entry?.key)
      .map(entry => [String(entry.key), String(entry.value ?? '')]),
  )
}

/**
 * Retrieves the normalized list of configured domains used when building the
 * /api/setting payload.
 */
async function handleSettingDomainsData(request, env) {
  // This is the internal helper used by handleSetting(): it fetches the canonical
  // domain list for the account and returns the same deduplicated domain data in the
  // format that the settings endpoint expects as "default domain" candidates.
  const [domainsResponse, customDomainsResponse] = await Promise.all([
    proxiedmailFetchOrThrow(request, env, '/gapi/available-domains', { authMode: 'bearer' }),
    proxiedmailFetchOrThrow(request, env, '/gapi/custom-domains?ignoreProcessing=1', { authMode: 'bearer' }),
  ])
  const [domainsBody, customDomainsBody] = await Promise.all([
    domainsResponse.json(),
    customDomainsResponse.json(),
  ])

  return dedupeSettingDomains([
    ...normalizeAvailableDomains(domainsBody).map(entry => ({ domain: entry.suffix.slice(1), is_custom: false })),
    ...normalizeCustomDomains(customDomainsBody).map(entry => ({ domain: entry.suffix.slice(1), is_custom: true })),
  ])
}

/**
 * Converts mailbox IDs from the SimpleLogin client into the underlying email
 * addresses used by ProxiedMail.
 */
async function resolveMailboxEmailsByIds(request, env, mailboxIds) {
  // The SimpleLogin client sends mailbox ids, but ProxiedMail's create/update calls
  // need actual email addresses. We resolve the ids against the normalized mailbox
  // list and map only the selected entries back to their email strings.
  const requestedIds = new Set(mailboxIds.map(value => String(value)))
  const mailboxes = await listRealEmails(request, env)

  return mailboxes
    .filter(mailbox => requestedIds.has(String(mailbox.id)))
    .map(mailbox => mailbox.email)
}

/**
 * Normalizes the upstream domain list into a uniform suffix structure that the
 * rest of the shim can consume.
 */
function normalizeAvailableDomains(body) {
  if (!Array.isArray(body)) {
    return []
  }

  return body
    .map(entry => {
      if (typeof entry === 'string') {
        return makeSuffixEntry(entry, false, false)
      }

      return makeSuffixEntry(entry?.domain, Boolean(entry?.isCustom), Boolean(entry?.isPremium))
    })
    .filter(Boolean)
}

/**
 * Normalizes custom-domain payloads in the same suffix format as built-in
 * ProxiedMail domains.
 */
function normalizeCustomDomains(body) {
  if (!Array.isArray(body)) {
    return []
  }

  return body
    .map(entry => makeSuffixEntry(entry?.domain_name ?? entry?.domain, true, false))
    .filter(Boolean)
}

/**
 * Builds a normalized suffix object containing the domain, signed suffix, and
 * premium/custom metadata.
 */
function makeSuffixEntry(domain, isCustom, isPremium) {
  const normalizedDomain = String(domain ?? '').trim().toLowerCase()

  if (!normalizedDomain || normalizedDomain === 'iam-rich.net') {
    return null
  }

  return {
    suffix: `@${normalizedDomain}`,
    signed_suffix: `@${normalizedDomain}`,
    is_custom: isCustom,
    is_premium: isPremium,
  }
}

/**
 * Deduplicates candidate domains while keeping the custom-domain version when both
 * versions exist for the same domain.
 */
function dedupeDomains(entries) {
  const seen = new Set()
  return entries.filter(entry => {
    if (!entry?.domain || seen.has(entry.domain)) {
      return false
    }
    seen.add(entry.domain)
    return true
  })
}

/**
 * Deduplicates suffix entries by domain suffix, preferring custom domains over
 * built-in ones when both are present.
 */
function dedupeSuffixEntries(entries) {
  const bySuffix = new Map()

  for (const entry of entries) {
    if (!entry?.suffix) {
      continue
    }

    const existing = bySuffix.get(entry.suffix)
    if (!existing || entry.is_custom) {
      bySuffix.set(entry.suffix, entry)
    }
  }

  return Array.from(bySuffix.values())
}

/**
 * Converts a ProxiedMail proxy-binding object into the SimpleLogin alias schema
 * used by the client application.
 */
function toSimpleLoginAlias(binding) {
  const attributes = binding?.attributes ?? {}
  const realAddresses = normalizeRealAddresses(attributes.real_addresses)
  const mailboxes = realAddresses.map((entry, index) => ({
    id: toSimpleLoginMailboxId(entry.email, index),
    email: entry.email,
  }))
  const firstMailbox = mailboxes[0] ?? null
  const enabled = realAddresses.some(entry => entry.is_enabled !== false)

  return {
    id: toSimpleLoginAliasId(binding?.id),
    alias: attributes.proxy_address ?? '',
    email: attributes.proxy_address ?? '',
    name: null,
    enabled,
    creation_date: attributes.created_at ?? null,
    creation_timestamp: toUnixTimestamp(attributes.created_at),
    note: attributes.description ?? '',
    nb_block: 0,
    nb_forward: Number(attributes.received_emails ?? 0),
    nb_reply: 0,
    support_pgp: false,
    disable_pgp: false,
    mailbox: firstMailbox,
    mailboxes,
    latest_activity: null,
    pinned: false,
  }
}

/**
 * Maps a ProxiedMail contact object into the SimpleLogin contact structure.
 */
function toSimpleLoginContact(entry) {
  const attributes = entry?.attributes ?? {}
  const contact = attributes.recipient_email

  if (!contact) {
    return null
  }

  return {
    id: toSimpleLoginAliasId(entry?.id),
    contact,
    creation_date: null,
    creation_timestamp: null,
    last_email_sent_date: null,
    last_email_sent_timestamp: null,
    reverse_alias: formatReverseAlias(contact, attributes.reverse_proxy_address),
    reverse_alias_address: attributes.reverse_proxy_address ?? null,
    block_forward: false,
  }
}

/**
 * Maps upstream activity entries into the SimpleLogin activity format.
 */
function toSimpleLoginActivity(entry, aliasAddress) {
  const attributes = entry?.attributes ?? {}
  const sender = attributes.sender_email

  if (!sender) {
    return null
  }

  return {
    action: 'forward',
    from: sender,
    to: attributes.recipient_email ?? aliasAddress ?? '',
    timestamp: toUnixTimestamp(attributes.created_at),
    reverse_alias: null,
    reverse_alias_address: null,
  }
}

/**
 * Produces a deterministic SimpleLogin-style ID for addresses and object IDs.
 */
function toSimpleLoginMailboxId(email, fallbackIndex) {
  if (!email) {
    return fallbackIndex + 1
  }

  return toSimpleLoginAliasId(email)
}

/**
 * Normalizes contact addresses for case-insensitive comparisons.
 */
function normalizeContactAddress(value) {
  return String(value ?? '').trim().toLowerCase()
}

/**
 * Formats reverse aliases in a human-readable form while keeping the actual
 * reverse alias address available separately.
 */
function formatReverseAlias(contact, reverseProxyAddress) {
  if (!reverseProxyAddress) {
    return contact
  }

  const localPart = String(contact).split('@')[0] ?? contact
  const displayName = `${localPart} at ${String(contact).split('@')[1] ?? ''}`.trim()
  return `${displayName} <${reverseProxyAddress}>`
}

/**
 * Accepts either an array or a map of real-address definitions and normalizes them
 * to a common { email, is_enabled } structure.
 */
function normalizeRealAddresses(value) {
  // Real-address state is represented in two incompatible shapes upstream: an array
  // of entries or a keyed object. The decision here is to normalize both into the
  // same [{ email, is_enabled }] form so all later code can do one consistent check:
  // "is this mailbox enabled or disabled?"
  if (Array.isArray(value)) {
    return value
      .map(entry => {
        if (typeof entry === 'string') {
          return { email: entry, is_enabled: true }
        }

        if (entry && typeof entry.email === 'string') {
          return {
            email: entry.email,
            is_enabled: entry.is_enabled !== false,
          }
        }

        return null
      })
      .filter(Boolean)
  }

  if (value && typeof value === 'object') {
    return Object.entries(value)
      .map(([email, details]) => ({
        email,
        is_enabled: details?.is_enabled !== false,
      }))
      .filter(entry => Boolean(entry.email))
  }

  return []
}

/**
 * De-dupes mailbox addresses while preserving the order of first appearance.
 */
function dedupeMailboxEmails(values) {
  const seen = new Set()
  const result = []

  for (const value of values) {
    const email = String(value ?? '').trim()
    if (!email || seen.has(email)) {
      continue
    }

    seen.add(email)
    result.push(email)
  }

  return result
}

/**
 * Counts how many aliases each real address currently owns so mailbox metadata can
 * report a total alias count to the client.
 */
function countAliasesByRealAddress(bindings) {
  const counts = new Map()

  for (const binding of bindings) {
    for (const entry of normalizeRealAddresses(binding?.attributes?.real_addresses)) {
      counts.set(entry.email, (counts.get(entry.email) ?? 0) + 1)
    }
  }

  return counts
}

function getBindingDomain(binding) {
  const proxyAddress = String(binding?.attributes?.proxy_address ?? '')
  return proxyAddress.split('@')[1]?.toLowerCase() ?? ''
}

/**
 * Keeps the first domain for each base domain while preferring custom domains when
 * both custom and default variants are available.
 */
function dedupeSettingDomains(entries) {
  const byDomain = new Map()

  for (const entry of entries) {
    if (!entry?.domain) {
      continue
    }

    const existing = byDomain.get(entry.domain)
    if (!existing || entry.is_custom) {
      byDomain.set(entry.domain, entry)
    }
  }

  return Array.from(byDomain.values())
}

/**
 * SimpleLogin exposes a user preference named random_alias_suffix. In the client,
 * this value is a mode selector, not a literal suffix text. The only modes this shim
 * actually understands are:
 *   - 'word' -> use a name-based alias prefix, e.g. "jane.doe"
 *   - 'random_string' -> keep the value as-is because the client explicitly sends it
 *     and the rest of the shim treats it as another supported mode.
 *
 * The decision is intentionally narrow: the shim does not attempt to support every
 * possible downstream suffix style. If the incoming value is anything else, we fall
 * back to 'word' instead of passing an unsupported value through to the upstream API.
 *
 * This is the exact whitelist enforced by the code below:
 *   normalized === 'random_string' || normalized === 'word'
 *
 * Anything else becomes 'word', so the settings endpoint always returns one of the two
 * modes the UI can actually render and the alias creation code understands.
 */
function normalizeRandomAliasSuffix(value) {
  const normalized = String(value ?? 'word').trim()
  if (normalized === 'random_string' || normalized === 'word') {
    return normalized
  }

  return 'word'
}

/**
 * Creates a stable numeric ID from an upstream identifier by hashing the string.
 */
function toSimpleLoginAliasId(value) {
  const input = String(value ?? '')
  let hash = 2166136261

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return (hash >>> 0) & 0x7fffffff
}

/**
 * Applies the enabled/disabled filter requested by the SimpleLogin client.
 */
function matchesAliasFilter(alias, searchParams) {
  if (searchParams.has('enabled')) {
    return alias.enabled
  }

  if (searchParams.has('disabled')) {
    return !alias.enabled
  }

  if (searchParams.has('pinned')) {
    return Boolean(alias.pinned)
  }

  return true
}

/**
 * Generates a SimpleLogin-style alias prefix suggestion from the incoming host.
 */
function hostnameSuggestion(hostname) {
  if (!hostname) {
    return ''
  }

  const candidate = hostname.split('.')[0] ?? ''
  return sanitizeAliasPrefix(candidate)
}

/**
 * Cleans alias prefixes so they remain valid for use in local-part generation.
 */
function sanitizeAliasPrefix(value) {
  const cleaned = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')

  return cleaned
}

/**
 * Strips a leading @ from a signed suffix and cleans any leading punctuation.
 */
function normalizeSignedSuffix(value) {
  const normalized = value.startsWith('@') ? value.slice(1) : value
  return normalized.replace(/^[.-]+/, '').trim()
}

/**
 * Generates a random alias prefix using the same word-based heuristics expected by
 * the SimpleLogin client, falling back to a UUID for non-word modes.
 */
function buildRandomPrefix(mode = 'word') {
  if (mode === 'word') {
    const given = generateName('given') + (Math.random() < 0.5 ? '' : `.${generateName('given')}`)
    const surname = generateName('surname') + (Math.random() < 0.5 ? '' : `-${generateName('surname')}`)
    return `${given}.${surname}`.toLowerCase()
  }

  return crypto.randomUUID()
}

/**
 * Picks one random value from an array.
 */
function pick(values) {
  return values[Math.floor(Math.random() * values.length)]
}

/**
 * Creates a short string identifier from a UUID.
 */
function shortId(length) {
  return crypto.randomUUID().replace(/-/g, '').slice(0, length)
}

/**
 * Converts an ISO-like timestamp into seconds since epoch, returning null when the
 * value cannot be parsed.
 */
function toUnixTimestamp(value) {
  const timestamp = Date.parse(value ?? '')
  return Number.isNaN(timestamp) ? null : Math.floor(timestamp / 1000)
}

/**
 * Forwards only the query keys explicitly allowed by the shim for compatibility.
 */
function forwardQuery(searchParams, allowedKeys) {
  const forwarded = new URLSearchParams()
  for (const key of allowedKeys) {
    for (const value of searchParams.getAll(key)) {
      forwarded.append(key, value)
    }
  }
  const query = forwarded.toString()
  return query ? `?${query}` : ''
}

/**
 * Safely reads and parses a JSON request body, converting malformed payloads into
 * a descriptive error.
 */
async function readJsonBody(request) {
  const contentLength = request.headers.get('content-length')
  if (contentLength === '0') {
    return {}
  }

  const text = await request.text()
  if (!text) {
    return {}
  }

  try {
    return JSON.parse(text)
  }
  catch {
    throw new Error('Invalid JSON body')
  }
}

/**
 * Performs a proxied fetch to the upstream ProxiedMail service while preserving
 * the incoming Authorization header in a compatibility-friendly way.
 */
async function proxiedmailFetch(request, env, path, options = {}) {
  const baseUrl = String(env.PROXIEDMAIL_BASE_URL || 'https://proxiedmail.com').replace(/\/$/, '')
  const targetUrl = `${baseUrl}${path}`
  const headers = new Headers(options.headers || {})
  headers.set('Accept', 'application/json')

  const incomingAuth = request.headers.get('Authentication') || request.headers.get('Authorization')
  if (incomingAuth) {
    const authValue = incomingAuth.replace(/^Bearer\s+/i, '').trim()
    if (options.authMode === 'bearer') {
      headers.set('Authorization', `Bearer ${authValue}`)
    }
    else {
      headers.set('Token', authValue)
    }
  }

  const response = await fetch(targetUrl, {
    method: options.method || 'GET',
    headers,
    body: options.body,
  })

  return response
}

/**
 * Fetches the upstream API and throws an HttpError when the response is not OK,
 * allowing the higher-level route handlers to return the right API status.
 */
async function proxiedmailFetchOrThrow(request, env, path, options = {}) {
  const response = await proxiedmailFetch(request, env, path, options)
  if (!response.ok) {
    throw await errorFromResponse(response)
  }

  return response
}

/**
 * Converts an upstream error response into the JSON payload that should be returned
 * to the SimpleLogin client.
 */
async function relayError(response) {
  return json(await safeJson(response), response.status)
}

/**
 * Builds a typed HttpError from an upstream response so route handlers can catch
 * and preserve the exact HTTP status and body.
 */
async function errorFromResponse(response) {
  const body = await safeJson(response)
  const message = body?.error || body?.message || `Request failed with status ${response.status}`
  return new HttpError(response.status, typeof body === 'object' && body !== null ? body : { error: message })
}

/**
 * Safely reads JSON from a response, falling back to a generic error payload when
 * parsing fails.
 */
async function safeJson(response) {
  try {
    return await response.json()
  }
  catch {
    return { error: `Request failed with status ${response.status}` }
  }
}

/**
 * Returns a JSON Response with the given body and status code.
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
  })
}

/**
 * Error type used by the shim to carry a specific HTTP status and body across
 * route handlers.
 */
class HttpError extends Error {
  constructor(status, body) {
    super(body?.error || body?.message || `Request failed with status ${status}`)
    this.status = status
    this.body = body
  }
}

/**
 * Generates human-readable random names using a model that encodes letter
 * transitions and starting bigrams.
 */
function generateName(type, minLen = 5, maxLen = 9) {
  const pool = NameModel.starts[type] ?? []
  const map = NameModel.transitions[type] ?? {}

  for (let attempt = 0; attempt < 10; attempt++) {
    const startBigram = pool[Math.floor(Math.random() * pool.length)]
    if (!startBigram) continue
    let bigram = startBigram
    let result = bigram

    let running = 50
    while (running && result.length < maxLen) {
      running--
      const possibleNext = map[bigram]
      if (!possibleNext) break

      const nextChar = possibleNext[Math.floor(Math.random() * possibleNext.length)]

      if (nextChar === null || nextChar === undefined) {
        if (result.length >= minLen) break
        continue
      }

      result += nextChar
      bigram = result.slice(-2)
    }

    if (running) return result.charAt(0).toUpperCase() + result.slice(1)
  }
  throw new Error('failed to generate name')
}
