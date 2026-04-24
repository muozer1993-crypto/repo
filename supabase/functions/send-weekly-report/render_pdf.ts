// deno-lint-ignore-file no-explicit-any

import { jsPDF } from "https://esm.sh/jspdf@2.5.1";
import { Report } from "./build_report.ts";

/**
 * Render the report to a PDF and return it as a Uint8Array ready to
 * attach to the outgoing Resend email.
 *
 * A4 portrait, Turkish-safe font (Helvetica + explicit encoding).
 * Keeps to two or three pages: summary → per-scene tables → last-5
 * session mini-tables.
 */
export async function renderPdf(report: Report): Promise<Uint8Array> {
  const doc = new jsPDF({
    unit: "pt",
    format: "a4",
  });

  const margin = 40;
  const lineHeight = 16;
  let y = margin;

  const heading = (text: string, size = 16) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(size);
    doc.text(text, margin, y);
    y += lineHeight * 1.5;
  };

  const line = (text: string) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.text(text, margin, y);
    y += lineHeight;
  };

  const newPageIfNeeded = (pad: number = 100) => {
    if (y > 800 - pad) {
      doc.addPage();
      y = margin;
    }
  };

  // Header
  heading(`Haftalik Rapor — ${report.profile.name}`, 18);
  line(
    `Tarih araligi: ${formatDate(report.range.from)} — ${
      formatDate(report.range.to)
    }`,
  );
  line(`Yas bandi: ${report.profile.age_band}`);
  y += lineHeight / 2;

  heading("Ozet", 14);
  const s = report.summary;
  line(`Toplam oturum: ${s.sessionCount}`);
  line(
    `Tamamlanan: ${s.completedCount}  (${percent(s.completionRate)})`,
  );
  line(`Toplam oyun suresi: ${s.totalPlayMinutes} dk`);
  line(
    `Uygulama acma: ${s.appOpensCount} (gunluk ort. ${
      s.avgDailyOpens.toFixed(1)
    })`,
  );
  const wd = s.windowDistribution;
  line(
    `Gun ici dagilim — sabah: ${wd.sabah}, oglen: ${wd.oglen}, ` +
      `ikindi: ${wd.ikindi}, aksam: ${wd.aksam}`,
  );
  if (s.orientationCorrectRate !== null) {
    line(
      `Zaman oryantasyonu: ${
        percent(s.orientationCorrectRate)
      } dogru, ort. yanit ${
        Math.round(s.orientationAvgResponseMs ?? 0)
      } ms`,
    );
  }
  line(
    `Ort. yonerge tekrari: ${s.avgInstructionReplays.toFixed(1)} oturum basi`,
  );
  y += lineHeight;

  // v2 — Oyun-1 / Oyun-2 / Bonus ozet
  heading("Oyun ayrimi", 14);
  line(
    `Oyun-1 tamamlanma: ${
      s.game1CompletionRate === null
        ? "yok"
        : percent(s.game1CompletionRate)
    }`,
  );
  line(
    `Oyun-2 tamamlanma: ${
      s.game2CompletionRate === null
        ? "yok"
        : percent(s.game2CompletionRate)
    }`,
  );
  line(`Bonus oyun: ${s.bonusPlayCount}`);
  line(
    `Bonus katilim: ${
      s.bonusEngagementRate === null
        ? "yok"
        : percent(s.bonusEngagementRate)
    }`,
  );
  line(`Kacirilan dilim: ${s.missedSlotCount}`);
  y += lineHeight;

  // v2 — Oyun-2 tip dagilimi
  if (Object.keys(report.game2TypeBreakdown).length > 0) {
    heading("Oyun-2 tip performansi", 14);
    for (const g of Object.values(report.game2TypeBreakdown)) {
      line(
        `${g.type}: ${g.playCount} oyun, tamamlanma ${
          percent(g.completionRate)
        }, ort. hata ${g.avgErrorCount.toFixed(1)}`,
      );
    }
    y += lineHeight;
  }

  // v2 — Bonus kullanim
  if (Object.keys(report.bonusBreakdown).length > 0) {
    heading("Bonus oyun kullanimi", 14);
    for (const b of Object.values(report.bonusBreakdown)) {
      line(
        `${b.type}: ${b.playCount} oyun, ort. ${
          b.avgTapCount.toFixed(0)
        } dokunus, gece: ${b.nightCount}`,
      );
    }
    y += lineHeight;
  }

  // v2 — Dilim kacirma haritasi (sade liste formu; ileride ayri PDF
  // sayfasinda gorsel heatmap'e donusturulur)
  if (report.missedSlotHeatmap.length > 0) {
    heading("Kacirma haritasi", 14);
    const dayLabels = [
      "Pzt",
      "Sal",
      "Car",
      "Per",
      "Cum",
      "Cmt",
      "Paz",
    ];
    for (const cell of report.missedSlotHeatmap) {
      line(
        `${dayLabels[cell.dayIndex]} / ${cell.window}: ${cell.count}`,
      );
    }
    y += lineHeight;
  }

  // Per-scene pages
  for (const sc of report.scenes) {
    newPageIfNeeded(200);
    heading(`Sahne: ${sc.sceneId}`, 14);
    line(`srInterval: ${sc.srInterval} / 4`);
    line(`difficultyLevel: ${sc.difficultyLevel} / 4`);
    line(`Oynanma: ${sc.playCount}   Tamamlanma: ${percent(sc.completionRate)}`);
    line(`Ort. tepkime: ${Math.round(sc.avgReactionMs)} ms`);
    line(`Ort. bekleme:  ${Math.round(sc.avgWaitMs)} ms`);
    line(`Ort. hata:     ${sc.avgErrorCount.toFixed(2)}`);

    line(
      `Celdirici hata orani — far: ${
        percent(sc.distractorErrorRates.far)
      }, near: ${percent(sc.distractorErrorRates.near)}, functional: ${
        percent(sc.distractorErrorRates.functional)
      }`,
    );
    if (sc.sequenceRequiredErrorRate !== null) {
      line(
        `Sirali gorev hata: ${
          percent(sc.sequenceRequiredErrorRate)
        }   Serbest: ${percent(sc.sequenceFreeErrorRate ?? 0)}`,
      );
    }
    y += lineHeight / 2;

    line("Son 5 oturum:");
    for (const row of sc.lastFive) {
      const dur = row.finished_at
        ? Math.round(
          (new Date(row.finished_at).getTime() -
            new Date(row.started_at).getTime()) / 1000,
        )
        : 0;
      line(
        `  ${formatDate(row.started_at)}  ${dur}s  hata:${row.error_count}  ${
          row.completed ? "[tamam]" : "[yarim]"
        }`,
      );
    }
    y += lineHeight;
  }

  // Finalize
  const arrayBuffer = doc.output("arraybuffer") as ArrayBuffer;
  return new Uint8Array(arrayBuffer);
}

function percent(x: number): string {
  return `%${Math.round(x * 100)}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
