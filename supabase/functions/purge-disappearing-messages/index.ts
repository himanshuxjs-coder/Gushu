import { createClient } from "npm:@supabase/supabase-js@2.108.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface PurgeResult {
  conversation_id: string;
  message_ids: string[];
  media_paths: (string | null)[];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  // Auth: require service_role key via Authorization header
  const authHeader = req.headers.get("authorization") ?? "";
  const expectedKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!expectedKey || authHeader !== `Bearer ${expectedKey}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Call the purge function — it returns media paths to clean up
    const { data, error } = await supabase.rpc(
      "purge_expired_disappearing_messages",
    );

    if (error) {
      console.error("[purge] RPC error:", error.message);
      return new Response(
        JSON.stringify({ success: false, error: error.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const results = (data ?? []) as PurgeResult[];
    const storagePathsToRemove: string[] = [];

    for (const group of results) {
      for (const path of group.media_paths ?? []) {
        if (path) storagePathsToRemove.push(path);
      }
    }

    // Remove storage objects (best-effort; log failures but don't fail the run)
    let storageRemoved = 0;
    if (storagePathsToRemove.length > 0) {
      try {
        const { error: storageError } = await supabase.storage
          .from("chat-media")
          .remove(storagePathsToRemove);
        if (storageError) {
          console.error("[purge] storage remove error:", storageError.message);
        } else {
          storageRemoved = storagePathsToRemove.length;
        }
      } catch (e) {
        console.error("[purge] storage remove exception:", String(e));
      }
    }

    const totalMessages = results.reduce(
      (n, g) => n + (g.message_ids?.length ?? 0),
      0,
    );

    return new Response(
      JSON.stringify({
        success: true,
        conversations_purged: results.length,
        messages_deleted: totalMessages,
        storage_objects_removed: storageRemoved,
        details: results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[purge] fatal:", String(err));
    return new Response(
      JSON.stringify({ success: false, error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
