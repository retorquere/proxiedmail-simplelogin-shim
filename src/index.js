const EMPTY_RESPONSE = { error: null, data: [] };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = matchRoute(request.method, url.pathname);

    if (!route) {
      return json(EMPTY_RESPONSE, 200);
    }

    try {
      return await route.handler(request, env, url, route.params);
    } catch (error) {
      if (error instanceof HttpError) {
        return json(error.body, error.status);
      }

      return json(
        {
          error: error instanceof Error ? error.message : "Unexpected error",
        },
        500,
      );
    }
  },
};

const routes = [
  { method: "GET", pattern: /^\/$/, handler: handleRoot },
  { method: "POST", pattern: /^\/api\/auth\/login$/, handler: handleAuthLogin },
  { method: "GET", pattern: /^\/api\/user_info$/, handler: handleRoot },
  { method: "GET", pattern: /^\/api\/setting$/, handler: handleSetting },
  { method: "PATCH", pattern: /^\/api\/setting$/, handler: handleSettingUpdate },
  { method: "GET", pattern: /^\/api\/v2\/setting\/domains$/, handler: handleSettingDomainsList },
  { method: "GET", pattern: /^\/api\/v5\/alias\/options$/, handler: handleAliasOptions },
  { method: "GET", pattern: /^\/api\/v2\/aliases$/, handler: handleAliasesList },
  { method: "GET", pattern: /^\/api\/v2\/mailboxes$/, handler: handleMailboxesList },
  { method: "POST", pattern: /^\/api\/v2\/aliases$/, handler: handleAliasesList },
  { method: "PATCH", pattern: /^\/api\/aliases\/([^/]+)$/, handler: handleAliasUpdate },
  { method: "PUT", pattern: /^\/api\/aliases\/([^/]+)$/, handler: handleAliasUpdate },
  { method: "GET", pattern: /^\/api\/aliases\/([^/]+)\/activities$/, handler: handleAliasActivities },
  { method: "GET", pattern: /^\/api\/aliases\/([^/]+)\/contacts$/, handler: handleAliasContactsList },
  { method: "POST", pattern: /^\/api\/aliases\/([^/]+)\/contacts$/, handler: handleAliasContactCreate },
  { method: "POST", pattern: /^\/api\/alias\/random\/new$/, handler: handleRandomAliasCreate },
  { method: "POST", pattern: /^\/api\/v3\/alias\/custom\/new$/, handler: handleCustomAliasCreate },
  { method: "POST", pattern: /^\/api\/aliases\/([^/]+)\/toggle$/, handler: handleAliasToggle },
  { method: "DELETE", pattern: /^\/api\/aliases\/([^/]+)$/, handler: handleAliasDelete },
];

function matchRoute(method, pathname) {
  for (const route of routes) {
    if (route.method !== method) {
      continue;
    }

    const match = pathname.match(route.pattern);
    if (match) {
      return { ...route, params: match.slice(1) };
    }
  }

  return null;
}

async function handleRoot(request, env) {
  const profile = await proxiedmailFetchOrThrow(request, env, "/api/v1/users/me?updateFrontCache=0", {
    authMode: "token",
  });
  const body = await profile.json();
  const isPremium = Boolean(body?.meta?.plan?.isPaid);

  return json({
    name: body?.data?.attributes?.username ?? "",
    is_premium: isPremium,
    email: body?.data?.attributes?.email ?? "",
    in_trial: false,
    trial_end_timestamp: null,
    profile_picture_url: null,
    max_alias_free_plan: body?.meta?.maxFreeProxyBindings ?? null,
    connected_proton_address: null,
    can_create_reverse_alias: true,
  });
}

async function handleAuthLogin(request, env) {
  const payload = await readJsonBody(request);
  const email = String(payload?.email ?? "").trim();
  const password = String(payload?.password ?? "");

  if (!email || !password) {
    return json({ error: "Email or password incorrect" }, 400);
  }

  const authResponse = await fetch(`${String(env.PROXIEDMAIL_BASE_URL || "https://proxiedmail.com").replace(/\/$/, "")}/api/v1/auth`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: {
        type: "auth-request",
        attributes: {
          username: email,
          password,
        },
      },
    }),
  });

  if (!authResponse.ok) {
    return json({ error: "Email or password incorrect" }, authResponse.status >= 400 && authResponse.status < 500 ? 400 : authResponse.status);
  }

  const authBody = await authResponse.json();
  const bearerToken = authBody?.data?.attributes?.token;
  if (!bearerToken) {
    return json({ error: "Email or password incorrect" }, 400);
  }

  const [apiTokenResponse, profileResponse] = await Promise.all([
    fetch(`${String(env.PROXIEDMAIL_BASE_URL || "https://proxiedmail.com").replace(/\/$/, "")}/api/v1/api-token`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
    }),
    fetch(`${String(env.PROXIEDMAIL_BASE_URL || "https://proxiedmail.com").replace(/\/$/, "")}/api/v1/users/me?updateFrontCache=0`, {
      headers: {
        Accept: "application/json",
        Token: bearerToken,
      },
    }),
  ]);

  if (!apiTokenResponse.ok) {
    return relayError(apiTokenResponse);
  }

  const apiTokenBody = await apiTokenResponse.json();
  const profileBody = profileResponse.ok ? await profileResponse.json() : null;

  return json({
    name: profileBody?.data?.attributes?.username ?? "",
    email: profileBody?.data?.attributes?.email ?? email,
    mfa_enabled: false,
    mfa_key: "",
    api_key: apiTokenBody?.token ?? "",
  });
}

async function handleAliasOptions(request, env, url) {
  const [domainsResponse, customDomainsResponse, aliasesResponse] = await Promise.all([
    proxiedmailFetchOrThrow(request, env, "/gapi/available-domains", { authMode: "bearer" }),
    proxiedmailFetchOrThrow(request, env, "/gapi/custom-domains?ignoreProcessing=1", { authMode: "bearer" }),
    proxiedmailFetchOrThrow(request, env, "/api/v1/proxy-bindings?sort=desc", { authMode: "token" }),
  ]);

  const [domainsBody, customDomainsBody, aliasesBody] = await Promise.all([
    domainsResponse.json(),
    customDomainsResponse.json(),
    aliasesResponse.json(),
  ]);

  const suffixes = [
    ...normalizeAvailableDomains(domainsBody),
    ...normalizeCustomDomains(customDomainsBody),
  ];

  return json({
    can_create: (aliasesBody?.meta?.availableProxyBindings ?? 0) > 0,
    suffixes,
    prefix_suggestion: hostnameSuggestion(url.searchParams.get("hostname")),
    recommendation: null,
  });
}

async function handleSettingDomainsList(request, env) {
  const [domainsResponse, customDomainsResponse] = await Promise.all([
    proxiedmailFetchOrThrow(request, env, "/gapi/available-domains", { authMode: "bearer" }),
    proxiedmailFetchOrThrow(request, env, "/gapi/custom-domains?ignoreProcessing=1", { authMode: "bearer" }),
  ]);
  const [domainsBody, customDomainsBody] = await Promise.all([
    domainsResponse.json(),
    customDomainsResponse.json(),
  ]);

  const domains = dedupeSettingDomains([
    ...normalizeAvailableDomains(domainsBody).map((entry) => ({ domain: entry.suffix.slice(1), is_custom: false })),
    ...normalizeCustomDomains(customDomainsBody).map((entry) => ({ domain: entry.suffix.slice(1), is_custom: true })),
  ]);

  return json(domains);
}

async function handleSetting(request, env) {
  const settings = await listProxiedmailSettings(request, env);
  const domains = await handleSettingDomainsData(request, env);

  return json({
    notification: true,
    alias_generator: "word",
    random_alias_default_domain: settings.get("random_alias_default_domain") ?? domains[0]?.domain ?? "",
    sender_format: settings.get("sender_format") ?? "AT",
    random_alias_suffix: normalizeRandomAliasSuffix(settings.get("random_alias_suffix")),
  });
}

async function handleSettingUpdate(request, env) {
  const payload = await readJsonBody(request);
  const nextSettings = [];

  if (Object.prototype.hasOwnProperty.call(payload, "random_alias_default_domain")) {
    nextSettings.push({
      key: "random_alias_default_domain",
      value: String(payload.random_alias_default_domain ?? ""),
    });
  }

  if (Object.prototype.hasOwnProperty.call(payload, "sender_format")) {
    nextSettings.push({
      key: "sender_format",
      value: String(payload.sender_format ?? "AT"),
    });
  }

  if (Object.prototype.hasOwnProperty.call(payload, "random_alias_suffix")) {
    const suffix = normalizeRandomAliasSuffix(payload.random_alias_suffix);
    nextSettings.push({
      key: "random_alias_suffix",
      value: suffix,
    });
  }

  if (nextSettings.length > 0) {
    const response = await proxiedmailFetch(request, env, "/gapi/settings/update", {
      authMode: "bearer",
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ settings: nextSettings }),
    });

    if (!response.ok) {
      return relayError(response);
    }
  }

  return handleSetting(request, env);
}

async function handleAliasesList(request, env, url) {
  if (!url.searchParams.has("page_id")) {
    return json({ error: "page_id must be provided in request query" }, 400);
  }

  const pageId = Math.max(Number.parseInt(url.searchParams.get("page_id") ?? "0", 10) || 0, 0);
  const response = await proxiedmailFetchOrThrow(request, env, `/api/v1/proxy-bindings${forwardQuery(url.searchParams, ["sort"])}${url.searchParams.has("sort") ? "" : "?sort=desc"}`, {
    authMode: "token",
  });
  const body = await response.json();
  const aliases = Array.isArray(body?.data)
    ? body.data
        .map(toSimpleLoginAlias)
        .filter((alias) => matchesAliasFilter(alias, url.searchParams))
        .slice(pageId * 20, (pageId + 1) * 20)
    : [];

  return json({ aliases });
}

async function handleMailboxesList(request, env) {
  const [realEmailsResponse, verifiedResponse, bindingsResponse] = await Promise.all([
    proxiedmailFetchOrThrow(request, env, "/gapi/real-emails", { authMode: "bearer" }),
    proxiedmailFetchOrThrow(request, env, "/gapi/verified-emails-list", { authMode: "bearer" }),
    proxiedmailFetchOrThrow(request, env, "/api/v1/proxy-bindings?sort=desc", { authMode: "token" }),
  ]);
  const [realEmailsBody, verifiedBody, bindingsBody] = await Promise.all([
    realEmailsResponse.json(),
    verifiedResponse.json(),
    bindingsResponse.json(),
  ]);

  const realEmails = Array.isArray(realEmailsBody?.data) ? realEmailsBody.data : [];
  const verifiedEmails = new Set(Array.isArray(verifiedBody?.List) ? verifiedBody.List.map((email) => String(email)) : []);
  const defaultRealAddress = await getDefaultRealAddress(request, env);
  const aliasCounts = countAliasesByRealAddress(Array.isArray(bindingsBody?.data) ? bindingsBody.data : []);

  const mailboxes = dedupeMailboxEmails([
    ...realEmails.map((entry) => entry?.email),
    ...verifiedEmails,
  ]).map((email) => ({
    id: toSimpleLoginMailboxId(email, 0),
    email,
    default: email === defaultRealAddress,
    creation_timestamp: null,
    nb_alias: aliasCounts.get(email) ?? 0,
    verified: verifiedEmails.has(email),
  }));

  return json({ mailboxes });
}

async function handleRandomAliasCreate(request, env, url) {
  const payload = await readJsonBody(request);
  const domainOptions = await listCandidateDomains(request, env);
  if (domainOptions.length === 0) {
    return json({ error: "No domains available" }, 400);
  }

  const realAddress = await getDefaultRealAddress(request, env);
  if (!realAddress) {
    return json({ error: "No verified mailbox available" }, 400);
  }

  const proxyAddress = `${buildRandomPrefix(url.searchParams.get("mode"))}@${domainOptions[0].domain}`;
  const created = await createProxyBinding(request, env, {
    proxy_address: proxyAddress,
    real_addresses: [realAddress],
  });

  let alias = created.data;

  if (payload?.note) {
    const updated = await patchProxyBinding(request, env, created.data.id, created.data.attributes.proxy_address, {
      description: String(payload.note),
    });
    alias = updated.data;
  }

  return json(toSimpleLoginAlias(alias), 201);
}

async function handleCustomAliasCreate(request, env) {
  const payload = await readJsonBody(request);
  const signedSuffix = String(payload?.signed_suffix ?? "").trim();
  const aliasPrefix = sanitizeAliasPrefix(payload?.alias_prefix);
  const domain = normalizeSignedSuffix(signedSuffix);

  if (!aliasPrefix || !domain) {
    return json({ error: "alias_prefix and signed_suffix are required" }, 400);
  }

  const realAddress = await getDefaultRealAddress(request, env);
  if (!realAddress) {
    return json({ error: "No verified mailbox available" }, 400);
  }

  const created = await createProxyBinding(request, env, {
    proxy_address: `${aliasPrefix}@${domain}`,
    real_addresses: [realAddress],
  });

  let alias = created.data;

  if (payload?.note) {
    const updated = await patchProxyBinding(request, env, created.data.id, created.data.attributes.proxy_address, {
      description: String(payload.note),
    });
    alias = updated.data;
  }

  return json(toSimpleLoginAlias(alias), 201);
}

async function handleAliasToggle(request, env, _url, params) {
  const aliasId = params[0];
  const binding = await getProxyBindingById(request, env, aliasId);
  const realAddresses = normalizeRealAddresses(binding.attributes?.real_addresses);
  const hasEnabled = realAddresses.some((entry) => entry.is_enabled !== false);
  const nextEnabled = !hasEnabled;
  const toggledAddresses = Object.fromEntries(
    realAddresses.map((entry) => [entry.email, nextEnabled]),
  );

  await patchProxyBinding(request, env, binding.id, binding.attributes?.proxy_address, {
    real_addresses: toggledAddresses,
  });

  return json({ enabled: nextEnabled });
}

async function handleAliasDelete(request, env, _url, params) {
  const aliasId = params[0];
  const binding = await getProxyBindingById(request, env, aliasId);
  const response = await proxiedmailFetch(request, env, `/api/v1/proxy-bindings/${encodeURIComponent(binding.id)}`, {
    authMode: "token",
    method: "DELETE",
  });

  if (!response.ok) {
    return relayError(response);
  }

  return json({ deleted: true });
}

async function handleAliasUpdate(request, env, _url, params) {
  const aliasId = params[0];
  const binding = await getProxyBindingById(request, env, aliasId);
  const payload = await readJsonBody(request);
  const nextAttributes = {};

  if (Object.prototype.hasOwnProperty.call(payload, "note")) {
    nextAttributes.description = String(payload.note ?? "");
  }

  const requestedMailboxIds = Array.isArray(payload?.mailbox_ids)
    ? payload.mailbox_ids
    : Object.prototype.hasOwnProperty.call(payload ?? {}, "mailbox_id")
      ? [payload.mailbox_id]
      : null;

  if (requestedMailboxIds) {
    const mailboxEmails = await resolveMailboxEmailsByIds(request, env, requestedMailboxIds);
    if (mailboxEmails.length === 0) {
      return json({ error: "Invalid mailbox_id" }, 400);
    }

    nextAttributes.real_addresses = Object.fromEntries(
      mailboxEmails.map((email) => [email, true]),
    );
  }

  const updated = await patchProxyBinding(
    request,
    env,
    binding.id,
    binding.attributes?.proxy_address,
    nextAttributes,
  );

  return json(toSimpleLoginAlias(updated.data));
}

async function handleAliasActivities(request, env, url, params) {
  const aliasId = params[0];
  const binding = await getProxyBindingById(request, env, aliasId);

  if (!url.searchParams.has("page_id")) {
    return json({ error: "page_id must be provided in request query" }, 400);
  }

  const pageId = Math.max(Number.parseInt(url.searchParams.get("page_id") ?? "0", 10) || 0, 0);
  const response = await proxiedmailFetch(
    request,
    env,
    `/api/v1/received-emails-links/${encodeURIComponent(binding.id)}`,
    { authMode: "token" },
  );

  if (response.status === 403) {
    return json({ activities: [] });
  }

  if (!response.ok) {
    return relayError(response);
  }

  const body = await response.json();
  const activities = Array.isArray(body?.data)
    ? body.data
        .slice(pageId * 20, (pageId + 1) * 20)
        .map((entry) => toSimpleLoginActivity(entry, binding.attributes?.proxy_address))
        .filter(Boolean)
    : [];

  return json({ activities });
}

async function handleAliasContactsList(request, env, url, params) {
  const aliasId = params[0];
  const binding = await getProxyBindingById(request, env, aliasId);
  const pageId = Math.max(Number.parseInt(url.searchParams.get("page_id") ?? "0", 10) || 0, 0);
  const response = await proxiedmailFetchOrThrow(
    request,
    env,
    `/api/v1/proxy-bindings/${encodeURIComponent(binding.id)}/contacts`,
    { authMode: "token" },
  );
  const body = await response.json();
  const contacts = Array.isArray(body?.data)
    ? body.data
        .slice(pageId * 20, (pageId + 1) * 20)
        .map(toSimpleLoginContact)
        .filter(Boolean)
    : [];

  return json({ contacts });
}

async function handleAliasContactCreate(request, env, _url, params) {
  const aliasId = params[0];
  const binding = await getProxyBindingById(request, env, aliasId);
  const payload = await readJsonBody(request);
  const contact = String(payload?.contact ?? "").trim();

  if (!contact) {
    return json({ error: "contact is required" }, 400);
  }

  const existingContactsResponse = await proxiedmailFetchOrThrow(
    request,
    env,
    `/api/v1/proxy-bindings/${encodeURIComponent(binding.id)}/contacts`,
    { authMode: "token" },
  );
  const existingContactsBody = await existingContactsResponse.json();
  const existingContact = Array.isArray(existingContactsBody?.data)
    ? existingContactsBody.data.find((entry) => normalizeContactAddress(entry?.attributes?.recipient_email) === normalizeContactAddress(contact))
    : null;

  if (existingContact) {
    return json({ ...toSimpleLoginContact(existingContact), existed: true });
  }

  const response = await proxiedmailFetch(request, env, "/api/v1/contacts", {
    authMode: "token",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: {
        type: "proxy_binding_contacts",
        attributes: {
          recipient_email: contact,
        },
        relationships: {
          proxy_binding: {
            data: {
              type: "proxy_bindings",
              id: String(binding.id),
            },
          },
        },
      },
    }),
  });

  if (!response.ok) {
    return relayError(response);
  }

  const body = await response.json();
  return json({ ...toSimpleLoginContact(body?.data), existed: false }, 201);
}

async function getProxyBindingById(request, env, id) {
  const response = await proxiedmailFetchOrThrow(request, env, `/api/v1/proxy-bindings?sort=desc`, {
    authMode: "token",
  });
  const body = await response.json();
  const requestedId = String(id);
  const found = Array.isArray(body?.data)
    ? body.data.find((entry) => {
        const guid = String(entry?.id ?? "");
        return guid === requestedId || String(toSimpleLoginAliasId(guid)) === requestedId;
      })
    : null;

  if (!found) {
    throw new Error(`Alias ${id} not found`);
  }

  return found;
}

async function createProxyBinding(request, env, attributes) {
  const response = await proxiedmailFetch(request, env, "/api/v1/proxy-bindings", {
    authMode: "token",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: {
        type: "proxy_bindings",
        attributes,
      },
    }),
  });

  if (!response.ok) {
    throw await errorFromResponse(response);
  }

  return response.json();
}

async function patchProxyBinding(request, env, id, proxyAddress, attributes) {
  const response = await proxiedmailFetch(request, env, `/api/v1/proxy-bindings/${encodeURIComponent(id)}`, {
    authMode: "token",
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: {
        id: String(id),
        type: "proxy_bindings",
        attributes: {
          proxy_address: proxyAddress,
          ...attributes,
        },
      },
    }),
  });

  if (!response.ok) {
    throw await errorFromResponse(response);
  }

  return response.json();
}

async function listCandidateDomains(request, env) {
  const [domainsResponse, customDomainsResponse] = await Promise.all([
    proxiedmailFetchOrThrow(request, env, "/gapi/available-domains", { authMode: "bearer" }),
    proxiedmailFetchOrThrow(request, env, "/gapi/custom-domains?ignoreProcessing=1", { authMode: "bearer" }),
  ]);
  const [domainsBody, customDomainsBody] = await Promise.all([
    domainsResponse.json(),
    customDomainsResponse.json(),
  ]);

  const domains = [
    ...normalizeAvailableDomains(domainsBody).map((entry) => ({ domain: entry.suffix.slice(1), is_custom: entry.is_custom })),
    ...normalizeCustomDomains(customDomainsBody).map((entry) => ({ domain: entry.suffix.slice(1), is_custom: entry.is_custom })),
  ];

  return dedupeDomains(domains);
}

async function getDefaultRealAddress(request, env) {
  const [verifiedResponse, realEmailsResponse] = await Promise.all([
    proxiedmailFetchOrThrow(request, env, "/gapi/verified-emails-list", { authMode: "bearer" }),
    proxiedmailFetchOrThrow(request, env, "/gapi/real-emails", { authMode: "bearer" }),
  ]);
  const [verifiedBody, realEmailsBody] = await Promise.all([
    verifiedResponse.json(),
    realEmailsResponse.json(),
  ]);

  const verified = Array.isArray(verifiedBody?.List) ? verifiedBody.List : [];
  const realEmails = Array.isArray(realEmailsBody?.data) ? realEmailsBody.data : [];
  const defaultEntry = realEmails.find((entry) => entry?.is_default && entry?.is_verified);

  return defaultEntry?.email ?? verified[0] ?? realEmails.find((entry) => entry?.is_verified)?.email ?? null;
}

async function listRealEmails(request, env) {
  const [realEmailsResponse, verifiedResponse] = await Promise.all([
    proxiedmailFetchOrThrow(request, env, "/gapi/real-emails", { authMode: "bearer" }),
    proxiedmailFetchOrThrow(request, env, "/gapi/verified-emails-list", { authMode: "bearer" }),
  ]);
  const [realEmailsBody, verifiedBody] = await Promise.all([
    realEmailsResponse.json(),
    verifiedResponse.json(),
  ]);

  const verifiedEmails = new Set(Array.isArray(verifiedBody?.List) ? verifiedBody.List.map((email) => String(email)) : []);
  const realEmails = Array.isArray(realEmailsBody?.data) ? realEmailsBody.data : [];

  return dedupeMailboxEmails([
    ...realEmails.map((entry) => entry?.email),
    ...verifiedEmails,
  ]).map((email) => ({
    id: toSimpleLoginMailboxId(email, 0),
    email,
    verified: verifiedEmails.has(email),
    default: Boolean(realEmails.find((entry) => entry?.email === email)?.is_default),
  }));
}

async function listProxiedmailSettings(request, env) {
  const response = await proxiedmailFetchOrThrow(request, env, "/gapi/settings", { authMode: "bearer" });
  const body = await response.json();
  const entries = Array.isArray(body) ? body : [];

  return new Map(
    entries
      .filter((entry) => entry?.key)
      .map((entry) => [String(entry.key), String(entry.value ?? "")]),
  );
}

async function handleSettingDomainsData(request, env) {
  const [domainsResponse, customDomainsResponse] = await Promise.all([
    proxiedmailFetchOrThrow(request, env, "/gapi/available-domains", { authMode: "bearer" }),
    proxiedmailFetchOrThrow(request, env, "/gapi/custom-domains?ignoreProcessing=1", { authMode: "bearer" }),
  ]);
  const [domainsBody, customDomainsBody] = await Promise.all([
    domainsResponse.json(),
    customDomainsResponse.json(),
  ]);

  return dedupeSettingDomains([
    ...normalizeAvailableDomains(domainsBody).map((entry) => ({ domain: entry.suffix.slice(1), is_custom: false })),
    ...normalizeCustomDomains(customDomainsBody).map((entry) => ({ domain: entry.suffix.slice(1), is_custom: true })),
  ]);
}

async function resolveMailboxEmailsByIds(request, env, mailboxIds) {
  const requestedIds = new Set(mailboxIds.map((value) => String(value)));
  const mailboxes = await listRealEmails(request, env);

  return mailboxes
    .filter((mailbox) => requestedIds.has(String(mailbox.id)))
    .map((mailbox) => mailbox.email);
}

function normalizeAvailableDomains(body) {
  if (!Array.isArray(body)) {
    return [];
  }

  return body
    .map((entry) => {
      if (typeof entry === "string") {
        return makeSuffixEntry(entry, false, false);
      }

      return makeSuffixEntry(entry?.domain, Boolean(entry?.isCustom), Boolean(entry?.isPremium));
    })
    .filter(Boolean);
}

function normalizeCustomDomains(body) {
  if (!Array.isArray(body)) {
    return [];
  }

  return body
    .map((entry) => makeSuffixEntry(entry?.domain_name ?? entry?.domain, true, false))
    .filter(Boolean);
}

function makeSuffixEntry(domain, isCustom, isPremium) {
  if (!domain) {
    return null;
  }

  return {
    suffix: `@${domain}`,
    signed_suffix: `@${domain}`,
    is_custom: isCustom,
    is_premium: isPremium,
  };
}

function dedupeDomains(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    if (!entry?.domain || seen.has(entry.domain)) {
      return false;
    }
    seen.add(entry.domain);
    return true;
  });
}

function toSimpleLoginAlias(binding) {
  const attributes = binding?.attributes ?? {};
  const realAddresses = normalizeRealAddresses(attributes.real_addresses);
  const mailboxes = realAddresses.map((entry, index) => ({
    id: toSimpleLoginMailboxId(entry.email, index),
    email: entry.email,
  }));
  const firstMailbox = mailboxes[0] ?? null;
  const enabled = realAddresses.some((entry) => entry.is_enabled !== false);

  return {
    id: toSimpleLoginAliasId(binding?.id),
    email: attributes.proxy_address ?? "",
    name: null,
    enabled,
    creation_date: attributes.created_at ?? null,
    creation_timestamp: toUnixTimestamp(attributes.created_at),
    note: attributes.description ?? "",
    nb_block: 0,
    nb_forward: Number(attributes.received_emails ?? 0),
    nb_reply: 0,
    support_pgp: false,
    disable_pgp: false,
    mailbox: firstMailbox,
    mailboxes,
    latest_activity: null,
    pinned: false,
  };
}

function toSimpleLoginContact(entry) {
  const attributes = entry?.attributes ?? {};
  const contact = attributes.recipient_email;

  if (!contact) {
    return null;
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
  };
}

function toSimpleLoginActivity(entry, aliasAddress) {
  const attributes = entry?.attributes ?? {};
  const sender = attributes.sender_email;

  if (!sender) {
    return null;
  }

  return {
    action: "forward",
    from: sender,
    to: attributes.recipient_email ?? aliasAddress ?? "",
    timestamp: toUnixTimestamp(attributes.created_at),
    reverse_alias: null,
    reverse_alias_address: null,
  };
}

function toSimpleLoginMailboxId(email, fallbackIndex) {
  if (!email) {
    return fallbackIndex + 1;
  }

  return toSimpleLoginAliasId(email);
}

function normalizeContactAddress(value) {
  return String(value ?? "").trim().toLowerCase();
}

function formatReverseAlias(contact, reverseProxyAddress) {
  if (!reverseProxyAddress) {
    return contact;
  }

  const localPart = String(contact).split("@")[0] ?? contact;
  const displayName = `${localPart} at ${String(contact).split("@")[1] ?? ""}`.trim();
  return `${displayName} <${reverseProxyAddress}>`;
}

function normalizeRealAddresses(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") {
          return { email: entry, is_enabled: true };
        }

        if (entry && typeof entry.email === "string") {
          return {
            email: entry.email,
            is_enabled: entry.is_enabled !== false,
          };
        }

        return null;
      })
      .filter(Boolean);
  }

  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([email, details]) => ({
        email,
        is_enabled: details?.is_enabled !== false,
      }))
      .filter((entry) => Boolean(entry.email));
  }

  return [];
}

function dedupeMailboxEmails(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const email = String(value ?? "").trim();
    if (!email || seen.has(email)) {
      continue;
    }

    seen.add(email);
    result.push(email);
  }

  return result;
}

function countAliasesByRealAddress(bindings) {
  const counts = new Map();

  for (const binding of bindings) {
    for (const entry of normalizeRealAddresses(binding?.attributes?.real_addresses)) {
      counts.set(entry.email, (counts.get(entry.email) ?? 0) + 1);
    }
  }

  return counts;
}

function dedupeSettingDomains(entries) {
  const byDomain = new Map();

  for (const entry of entries) {
    if (!entry?.domain) {
      continue;
    }

    const existing = byDomain.get(entry.domain);
    if (!existing || entry.is_custom) {
      byDomain.set(entry.domain, entry);
    }
  }

  return Array.from(byDomain.values());
}

function normalizeRandomAliasSuffix(value) {
  const normalized = String(value ?? "word").trim();
  if (normalized === "random_string" || normalized === "word") {
    return normalized;
  }

  return "word";
}

function toSimpleLoginAliasId(value) {
  const input = String(value ?? "");
  let hash = 2166136261;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0) & 0x7fffffff;
}

function matchesAliasFilter(alias, searchParams) {
  if (searchParams.has("enabled")) {
    return alias.enabled;
  }

  if (searchParams.has("disabled")) {
    return !alias.enabled;
  }

  if (searchParams.has("pinned")) {
    return Boolean(alias.pinned);
  }

  return true;
}

function hostnameSuggestion(hostname) {
  if (!hostname) {
    return "";
  }

  const candidate = hostname.split(".")[0] ?? "";
  return sanitizeAliasPrefix(candidate);
}

function sanitizeAliasPrefix(value) {
  const cleaned = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");

  return cleaned;
}

function normalizeSignedSuffix(value) {
  const normalized = value.startsWith("@") ? value.slice(1) : value;
  return normalized.replace(/^[.-]+/, "").trim();
}

function buildRandomPrefix(mode) {
  if (mode === "word") {
    return `${pick(WORDS)}-${pick(WORDS)}-${shortId(4)}`;
  }

  return crypto.randomUUID();
}

function pick(values) {
  return values[Math.floor(Math.random() * values.length)];
}

function shortId(length) {
  return crypto.randomUUID().replace(/-/g, "").slice(0, length);
}

function toUnixTimestamp(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isNaN(timestamp) ? null : Math.floor(timestamp / 1000);
}

function forwardQuery(searchParams, allowedKeys) {
  const forwarded = new URLSearchParams();
  for (const key of allowedKeys) {
    for (const value of searchParams.getAll(key)) {
      forwarded.append(key, value);
    }
  }
  const query = forwarded.toString();
  return query ? `?${query}` : "";
}

async function readJsonBody(request) {
  const contentLength = request.headers.get("content-length");
  if (contentLength === "0") {
    return {};
  }

  const text = await request.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

async function proxiedmailFetch(request, env, path, options = {}) {
  const baseUrl = String(env.PROXIEDMAIL_BASE_URL || "https://proxiedmail.com").replace(/\/$/, "");
  const targetUrl = `${baseUrl}${path}`;
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");

  const incomingAuth = request.headers.get("Authentication") || request.headers.get("Authorization");
  if (incomingAuth) {
    const authValue = incomingAuth.replace(/^Bearer\s+/i, "").trim();
    if (options.authMode === "bearer") {
      headers.set("Authorization", `Bearer ${authValue}`);
    } else {
      headers.set("Token", authValue);
    }
  }

  const response = await fetch(targetUrl, {
    method: options.method || "GET",
    headers,
    body: options.body,
  });

  return response;
}

async function proxiedmailFetchOrThrow(request, env, path, options = {}) {
  const response = await proxiedmailFetch(request, env, path, options);
  if (!response.ok) {
    throw await errorFromResponse(response);
  }

  return response;
}

async function relayError(response) {
  return json(await safeJson(response), response.status);
}

async function errorFromResponse(response) {
  const body = await safeJson(response);
  const message = body?.error || body?.message || `Request failed with status ${response.status}`;
  return new HttpError(response.status, typeof body === "object" && body !== null ? body : { error: message });
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return { error: `Request failed with status ${response.status}` };
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

class HttpError extends Error {
  constructor(status, body) {
    super(body?.error || body?.message || `Request failed with status ${status}`);
    this.status = status;
    this.body = body;
  }
}

const WORDS = [
  "amber",
  "cedar",
  "cinder",
  "delta",
  "ember",
  "fable",
  "harbor",
  "indigo",
  "juniper",
  "kepler",
];