// deno-lint-ignore-file no-explicit-any

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

import { AppOpen, buildReport, Placement, Session } from "./build_report.ts";
import { renderCsvs } from "./render_csv.ts";
import { renderPdf } from "./render_pdf.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY")!;
const FROM_ADDRESS = Deno.env.get("REPORT_FROM_ADDRESS") ??
  "raporlar@ergoterapi-app.tr";

/**
 * Weekly report Edge Function.
 *
 * Entry point: `POST /send-weekly-report` with `{ profile_id: uuid }`.
 *
 * Flow:
 *   1. Read last 7 days of sessions/placements/app_opens for the
 *      profile via the service-role client (bypasses RLS).
 *   2. Aggregate with buildReport() → Report object.
 *   3. Render PDF + 3 CSVs.
 *   4. POST to Resend with all four attachments.
 *   5. Insert report_sends row (ok true/false).
 */
serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  let profileId: string;
  try {
    const body = await req.json();
    profileId = body.profile_id;
    if (!profileId || typeof profileId !== "string") {
      return new Response("profile_id required", { status: 400 });
    }
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const to = new Date();
  const from = new Date(to.getTime() - 7 * 86_400_000);

  try {
    const [profile, sessions, placements, appOpens] = await Promise.all([
      admin
        .from("profiles")
        .select("*")
        .eq("id", profileId)
        .single()
        .then((r: any) => r.data),
      admin
        .from("sessions")
        .select("*")
        .eq("profile_id", profileId)
        .gte("started_at", from.toISOString())
        .then((r: any) => (r.data ?? []) as Session[]),
      admin
        .from("placements")
        .select("*")
        .eq("profile_id", profileId)
        .gte("at", from.toISOString())
        .then((r: any) => (r.data ?? []) as Placement[]),
      admin
        .from("app_opens")
        .select("*")
        .eq("profile_id", profileId)
        .gte("at", from.toISOString())
        .then((r: any) => (r.data ?? []) as AppOpen[]),
    ]);

    if (!profile) {
      return new Response("profile not found", { status: 404 });
    }

    const report = buildReport({
      profile,
      sessions,
      placements,
      appOpens,
      from,
      to,
    });

    const pdf = await renderPdf(report);
    const csvs = renderCsvs({ sessions, placements, appOpens });

    const today = to.toISOString().slice(0, 10).replaceAll("-", "");
    const subject = `${profile.name} — Haftalik Rapor (${
      to.toISOString().slice(0, 10)
    })`;

    const emailResp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_KEY}`,
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: profile.therapist_email,
        subject,
        text: summaryText(report),
        attachments: [
          {
            filename: `rapor-${today}.pdf`,
            content: toBase64(pdf),
          },
          {
            filename: "session_logs.csv",
            content: btoa(csvs.sessions),
          },
          {
            filename: "placements.csv",
            content: btoa(csvs.placements),
          },
          {
            filename: "app_opens.csv",
            content: btoa(csvs.appOpens),
          },
        ],
      }),
    });

    if (!emailResp.ok) {
      const err = await emailResp.text();
      await admin.from("report_sends").insert({
        profile_id: profileId,
        ok: false,
        error: `resend ${emailResp.status}: ${err.slice(0, 500)}`,
      });
      return new Response("resend failed", { status: 502 });
    }

    await admin.from("report_sends").insert({
      profile_id: profileId,
      ok: true,
    });

    return new Response(JSON.stringify({ status: "sent" }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    await admin
      .from("report_sends")
      .insert({
        profile_id: profileId,
        ok: false,
        error: String(e).slice(0, 500),
      });
    return new Response("internal error", { status: 500 });
  }
});

function summaryText(report: any): string {
  const s = report.summary;
  const p = report.profile;
  const wd = s.windowDistribution;
  return [
    `Hasta: ${p.name} (${p.age_band})`,
    `Tarih araligi: ${report.range.from.slice(0, 10)} — ${
      report.range.to.slice(0, 10)
    }`,
    "",
    `Toplam oturum: ${s.sessionCount} (tamamlanma ${
      Math.round(s.completionRate * 100)
    }%)`,
    `Toplam sure: ${s.totalPlayMinutes} dk`,
    `Uygulama acma: ${s.appOpensCount} (gunluk ort. ${
      s.avgDailyOpens.toFixed(1)
    })`,
    `Gun ici: sabah ${wd.sabah}, oglen ${wd.oglen}, ikindi ${wd.ikindi}, aksam ${wd.aksam}`,
    s.orientationCorrectRate === null
      ? ""
      : `Zaman oryantasyonu dogruluk: ${
        Math.round(s.orientationCorrectRate * 100)
      }%`,
    `Ort. yonerge tekrari / oturum: ${s.avgInstructionReplays.toFixed(1)}`,
    "",
    "Ayrintilar icin PDF ve CSV eklerini inceleyiniz.",
  ].filter(Boolean).join("\n");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + chunk, bytes.length)),
    );
  }
  return btoa(binary);
}
