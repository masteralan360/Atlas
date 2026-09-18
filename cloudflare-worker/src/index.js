function createCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Workspace-Usage-Client-Recorded",
    "Access-Control-Max-Age": "86400",
  };
}

const MAX_PRODUCT_IMAGE_IMPORT_BYTES = 10 * 1024 * 1024;
const MAX_PRODUCT_IMAGE_IMPORT_REQUEST_BYTES = 4096;
const MAX_PRODUCT_IMAGE_REDIRECTS = 3;

function matchesBytes(bytes, expected, offset = 0) {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function detectProductImageMime(bytes) {
  // Wait for enough bytes to distinguish the supported formats. A later full
  // browser decode is still required before the resulting file reaches R2.
  if (bytes.length < 12) return null;
  if (matchesBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (matchesBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (matchesBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || matchesBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return "image/gif";
  if (matchesBytes(bytes, [0x52, 0x49, 0x46, 0x46]) && matchesBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  if (matchesBytes(bytes, [0x66, 0x74, 0x79, 0x70], 4)
      && (matchesBytes(bytes, [0x61, 0x76, 0x69, 0x66], 8) || matchesBytes(bytes, [0x61, 0x76, 0x69, 0x73], 8))) {
    return "image/avif";
  }
  return false;
}

function isBlockedIpv4(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false;
  const values = parts.map(Number);
  if (values.some((part) => part < 0 || part > 255)) return true;
  const [first, second] = values;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && (second === 0 || second === 168))
    || (first === 198 && (second === 18 || second === 19 || second === 51))
    || (first === 203 && second === 0)
    || first >= 224;
}

function validateExternalProductImageUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("A public image URL is required");
  }

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("The image URL is invalid");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!["http:", "https:"].includes(url.protocol) || !hostname || url.username || url.password) {
    throw new Error("The image URL must be a public HTTP or HTTPS address");
  }

  // Hostname-based requests run from Cloudflare's network. Explicit local,
  // private, multicast, and IPv6 literals are rejected before any fetch; every
  // redirect is validated again below.
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")
      || hostname.includes(":") || isBlockedIpv4(hostname)) {
    throw new Error("The image URL must not point to a private network");
  }

  return url;
}

async function readImportRequestJson(request) {
  const declaredLength = parseContentLength(request.headers.get("Content-Length"));
  if (declaredLength !== null && declaredLength > MAX_PRODUCT_IMAGE_IMPORT_REQUEST_BYTES) {
    throw new Error("The import request is too large");
  }
  if (!request.body) throw new Error("An image URL is required");

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PRODUCT_IMAGE_IMPORT_REQUEST_BYTES) {
        throw new Error("The import request is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("The import request is invalid");
  }
}

function createValidatedProductImageStream(body) {
  let total = 0;
  let prefix = new Uint8Array(0);
  let detectedMime = null;

  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      total += bytes.byteLength;
      if (total > MAX_PRODUCT_IMAGE_IMPORT_BYTES) {
        throw new Error("The downloaded image exceeds the 10 MB limit");
      }

      if (prefix.length < 12) {
        const remaining = 12 - prefix.length;
        const next = new Uint8Array(prefix.length + Math.min(remaining, bytes.length));
        next.set(prefix);
        next.set(bytes.subarray(0, remaining), prefix.length);
        prefix = next;
      }
      if (!detectedMime && prefix.length >= 12) {
        detectedMime = detectProductImageMime(prefix);
        if (!detectedMime) {
          throw new Error("The downloaded file is not a supported image");
        }
      }
      controller.enqueue(bytes);
    },
    flush() {
      if (!detectedMime) {
        throw new Error("The downloaded file is not a supported image");
      }
    },
  }));
}

async function fetchExternalProductImage(value, corsHeaders) {
  let target = validateExternalProductImageUrl(value);

  for (let redirectCount = 0; redirectCount <= MAX_PRODUCT_IMAGE_REDIRECTS; redirectCount += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let response;
    try {
      response = await fetch(target, {
        redirect: "manual",
        signal: controller.signal,
        headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1" },
      });
    } catch {
      throw new Error("The image could not be downloaded");
    } finally {
      clearTimeout(timeout);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("Location");
      if (!location || redirectCount === MAX_PRODUCT_IMAGE_REDIRECTS) {
        throw new Error("The image URL redirected too many times");
      }
      target = validateExternalProductImageUrl(new URL(location, target).toString());
      continue;
    }
    if (!response.ok || !response.body) {
      throw new Error("The image could not be downloaded");
    }

    const declaredLength = parseContentLength(response.headers.get("Content-Length"));
    if (declaredLength !== null && declaredLength > MAX_PRODUCT_IMAGE_IMPORT_BYTES) {
      throw new Error("The downloaded image exceeds the 10 MB limit");
    }

    const headers = new Headers(corsHeaders);
    headers.set("Content-Type", "application/octet-stream");
    headers.set("Cache-Control", "no-store");
    return new Response(createValidatedProductImageStream(response.body), { headers });
  }

  throw new Error("The image could not be downloaded");
}

function jsonResponse(payload, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "application/json");

  return new Response(JSON.stringify(payload), {
    ...init,
    headers,
  });
}

function getSupabaseConfig(env) {
  const supabaseUrl = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || "").replace(/\/+$/, "");
  const supabaseAnonKey = env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || "";

  if (!supabaseUrl || !supabaseAnonKey) {
    return null;
  }

  return { supabaseUrl, supabaseAnonKey };
}

function getSupabaseServiceConfig(env) {
  const supabaseUrl = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || "").replace(/\/+$/, "");
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || "";

  if (!supabaseUrl || !serviceRoleKey) {
    return null;
  }

  return { supabaseUrl, serviceRoleKey };
}

function timingSafeEqual(left, right) {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);

  if (leftBytes.length !== rightBytes.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    diff |= leftBytes[index] ^ rightBytes[index];
  }

  return diff === 0;
}

function getWorkspaceIdFromPath(path) {
  const parts = path.replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts.length === 0) return null;

  if (parts[0] === "local-backup") {
    return parts[1] || null;
  }

  return parts[0] || null;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || "");
}

function parseContentLength(value) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
}

function wasUsageClientRecorded(request) {
  const url = new URL(request.url);
  return request.headers.get("X-Workspace-Usage-Client-Recorded") === "1"
    || url.searchParams.get("usage_client_recorded") === "1";
}

async function recordWorkspaceDataTransfer(env, workspaceId, bytes, source) {
  const byteCount = Math.trunc(Number(bytes) || 0);
  if (!isUuid(workspaceId) || byteCount <= 0) return { ok: true };

  const config = getSupabaseServiceConfig(env);
  if (!config) return { ok: true, skipped: true };

  const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/record_workspace_data_transfer`, {
    method: "POST",
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      p_workspace_id: workspaceId,
      p_bytes: byteCount,
      p_source: source,
      // This fallback is used by direct desktop/public-worker traffic. Web
      // Live requests are marked usage_client_recorded and are charged by the
      // trusted Vercel gateway at the web_live rate instead.
      p_channel: "tauri",
    }),
  });

  if (response.ok) {
    return { ok: true };
  }

  const errorText = await response.text().catch(() => "");
  const limitExceeded = errorText.includes("Workspace monthly data transfer limit exceeded");

  return {
    ok: false,
    response: jsonResponse(
      {
        error: limitExceeded
          ? "Workspace monthly data transfer limit exceeded"
          : "Workspace usage could not be recorded",
      },
      { status: limitExceeded ? 429 : 502, headers: createCorsHeaders() },
    ),
  };
}

function isAuthenticatedServiceRequest(request, env) {
  const serviceToken = env.R2_WORKER_SERVICE_TOKEN || env.R2_SERVICE_TOKEN || "";
  const providedToken = request.headers.get("X-R2-Service-Token") || "";

  return Boolean(serviceToken && providedToken && timingSafeEqual(providedToken, serviceToken));
}

async function requireAuthenticatedUser(request, env, corsHeaders) {
  if (isAuthenticatedServiceRequest(request, env)) {
    return { service: true };
  }

  const config = getSupabaseConfig(env);
  if (!config) {
    return {
      response: jsonResponse(
        { error: "R2 worker authentication is not configured" },
        { status: 500, headers: corsHeaders },
      ),
    };
  }

  const authHeader = request.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return {
      response: jsonResponse(
        { error: "Authentication required" },
        { status: 401, headers: corsHeaders },
      ),
    };
  }

  try {
    const authResponse = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: config.supabaseAnonKey,
        Authorization: authHeader,
      },
    });

    if (!authResponse.ok) {
      const status = authResponse.status >= 500 ? 502 : 401;
      return {
        response: jsonResponse(
          { error: status === 401 ? "Authentication required" : "Authentication service unavailable" },
          { status, headers: corsHeaders },
        ),
      };
    }

    const user = await authResponse.json();
    if (!user?.id) {
      return {
        response: jsonResponse(
          { error: "Authentication required" },
          { status: 401, headers: corsHeaders },
        ),
      };
    }

    return { user };
  } catch (error) {
    return {
      response: jsonResponse(
        { error: error?.message || "Authentication failed" },
        { status: 502, headers: corsHeaders },
      ),
    };
  }
}

export default {
  async fetch(request, env) {
    const corsHeaders = createCorsHeaders();

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname.slice(1);

    if (request.method === "POST" && path === "__product-image-import__") {
      const authResult = await requireAuthenticatedUser(request, env, corsHeaders);
      if (authResult.response) return authResult.response;

      try {
        const payload = await readImportRequestJson(request);
        return await fetchExternalProductImage(payload?.url, corsHeaders);
      } catch (error) {
        return jsonResponse(
          { error: error?.message || "The image could not be imported" },
          { status: 400, headers: corsHeaders },
        );
      }
    }

    if (request.method === "GET") {
      const isListRequest = url.searchParams.get("list") === "1";
      if (isListRequest) {
        const authResult = await requireAuthenticatedUser(request, env, corsHeaders);
        if (authResult.response) return authResult.response;

        const prefix = url.searchParams.get("prefix");
        if (!prefix) {
          return jsonResponse(
            { error: "Missing prefix query parameter" },
            { status: 400, headers: corsHeaders },
          );
        }

        try {
          let cursor = undefined;
          const keys = [];

          do {
            const listResult = await env.MY_BUCKET.list({ prefix, cursor });
            for (const object of listResult.objects || []) {
              if (object?.key) {
                keys.push(object.key);
              }
            }
            cursor = listResult.truncated ? listResult.cursor : undefined;
          } while (cursor);

          return jsonResponse({ keys }, { headers: corsHeaders });
        } catch (error) {
          return jsonResponse(
            { error: error?.message || "Failed to list objects" },
            { status: 500, headers: corsHeaders },
          );
        }
      }

      const object = await env.MY_BUCKET.get(path);
      if (object === null) {
        return new Response("Object Not Found", {
          status: 404,
          headers: corsHeaders,
        });
      }

      if (!wasUsageClientRecorded(request)) {
        const workspaceId = getWorkspaceIdFromPath(path);
        const usageResult = await recordWorkspaceDataTransfer(env, workspaceId, object.size, "r2_download");
        if (!usageResult.ok) return usageResult.response;
      }

      const headers = new Headers(corsHeaders);
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("Content-Length", String(object.size));
      if (/\/printed-invoices\/versions\//i.test(`/${path}`)) {
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
      } else if (/\/printed-invoices\/(A4|receipts)\//i.test(`/${path}`)) {
        // Stable QR aliases always represent the latest saved version.
        headers.set("Cache-Control", "public, max-age=0, must-revalidate");
      } else {
        headers.set("Cache-Control", "public, max-age=3600");
      }

      return new Response(object.body, { headers });
    }

    if (request.method === "PUT") {
      const authResult = await requireAuthenticatedUser(request, env, corsHeaders);
      if (authResult.response) return authResult.response;

      try {
        const clientRecorded = wasUsageClientRecorded(request);
        const contentLength = parseContentLength(request.headers.get("Content-Length"));
        const workspaceId = getWorkspaceIdFromPath(path);

        const object = await env.MY_BUCKET.put(path, request.body, {
          httpMetadata: {
            contentType: request.headers.get("Content-Type") || "application/octet-stream",
          },
        });

        const uploadedBytes = object?.size || contentLength;
        if (!clientRecorded && uploadedBytes !== null) {
          const usageResult = await recordWorkspaceDataTransfer(env, workspaceId, uploadedBytes, "r2_upload");
          if (!usageResult.ok) return usageResult.response;
        }

        return jsonResponse({ success: true, key: path }, { headers: corsHeaders });
      } catch (error) {
        return new Response(error?.message || "Failed to upload object", {
          status: 500,
          headers: corsHeaders,
        });
      }
    }

    if (request.method === "DELETE") {
      const authResult = await requireAuthenticatedUser(request, env, corsHeaders);
      if (authResult.response) return authResult.response;

      await env.MY_BUCKET.delete(path);
      return jsonResponse({ success: true }, { headers: corsHeaders });
    }

    return new Response("Method Not Allowed", {
      status: 405,
      headers: corsHeaders,
    });
  },
};
