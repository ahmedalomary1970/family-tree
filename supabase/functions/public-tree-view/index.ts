import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const token = url.searchParams.get("token");

    if (!token) {
      return new Response(JSON.stringify({ error: "missing_token" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: share, error: shareError } = await supabase
      .from("tree_shares")
      .select("tree_id, title, is_active, expires_at")
      .eq("share_token", token)
      .maybeSingle();

    if (shareError || !share) {
      return new Response(JSON.stringify({ error: "invalid_link" }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    if (!share.is_active) {
      return new Response(JSON.stringify({ error: "link_disabled" }), {
        status: 403,
        headers: corsHeaders,
      });
    }

    if (share.expires_at && new Date(share.expires_at).getTime() < Date.now()) {
      return new Response(JSON.stringify({ error: "link_expired" }), {
        status: 403,
        headers: corsHeaders,
      });
    }

   const { data: project, error: projectError } = await supabase
  .from("projects")
  .select("id, name, data")
  .eq("id", share.tree_id)
  .maybeSingle();

if (projectError || !project) {
  return new Response(JSON.stringify({ error: "tree_load_failed" }), {
    status: 500,
    headers: corsHeaders,
  });
}

    return new Response(
  JSON.stringify({
    readOnly: true,
    title: project.name,
    tree_id: project.id,
    data: project.data,
  }),
  {
    status: 200,
    headers: corsHeaders,
  }
);
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: "server_error",
        detail: String(err),
      }),
      {
        status: 500,
        headers: corsHeaders,
      }
    );
  }
});