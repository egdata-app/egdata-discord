import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { client } from "../utils/client.js";
import { BaseCommand } from "../types/BaseCommand.js";

interface MonthlyReleaseRow {
  year: number;
  month: number;
  releases: number;
}

interface YearlyReleaseRow {
  year: number;
  releases: number;
}

interface MonthlyCreationRow {
  year: number;
  month: number;
  creations: number;
}

interface YearlyCreationRow {
  year: number;
  creations: number;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const SHORT_MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function formatMonthYear(year: number, month: number, short = false): string {
  const names = short ? SHORT_MONTH_NAMES : MONTH_NAMES;
  const monthName = names[month - 1] ?? `M${month}`;
  return `${monthName} ${year}`;
}

export class ReleaseStatsCommand extends BaseCommand {
  override data = new SlashCommandBuilder()
    .setName("release-stats")
    .setDescription(
      "View Epic Games Store game release statistics (this month, this year, peak month/year, and trends)."
    )
    .addStringOption((option) =>
      option
        .setName("metric")
        .setDescription("Choose between official release dates or store creation dates.")
        .setRequired(false)
        .addChoices(
          { name: "Releases (by release date)", value: "releases" },
          { name: "Store Creations (by creation date)", value: "creations" }
        )
    );

  private async fetchStats(metric: "releases" | "creations"): Promise<{
    monthly: Array<{ year: number; month: number; count: number }>;
    yearly: Array<{ year: number; count: number }>;
  }> {
    if (metric === "creations") {
      const [monthlyRes, yearlyRes] = await Promise.all([
        client.get<MonthlyCreationRow[]>("/stats/creations/monthly"),
        client.get<YearlyCreationRow[]>("/stats/creations/yearly"),
      ]);
      return {
        monthly: (monthlyRes.data ?? []).map((r) => ({
          year: r.year,
          month: r.month,
          count: r.creations,
        })),
        yearly: (yearlyRes.data ?? []).map((r) => ({
          year: r.year,
          count: r.creations,
        })),
      };
    }

    const [monthlyRes, yearlyRes] = await Promise.all([
      client.get<MonthlyReleaseRow[]>("/stats/releases/monthly"),
      client.get<YearlyReleaseRow[]>("/stats/releases/yearly"),
    ]);
    return {
      monthly: (monthlyRes.data ?? []).map((r) => ({
        year: r.year,
        month: r.month,
        count: r.releases,
      })),
      yearly: (yearlyRes.data ?? []).map((r) => ({
        year: r.year,
        count: r.releases,
      })),
    };
  }

  override async execute(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    await interaction.deferReply();

    const metric =
      (interaction.options.getString("metric") as "releases" | "creations") ??
      "releases";
    const isCreations = metric === "creations";
    const noun = isCreations ? "creations" : "releases";

    const data = await this.fetchStats(metric).catch((error) => {
      this.logger.error("Failed to fetch release stats:", error);
      return null;
    });

    if (!data || (data.monthly.length === 0 && data.yearly.length === 0)) {
      await interaction.editReply({
        content: "Failed to fetch release statistics from EGData API.",
      });
      return;
    }

    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth() + 1;

    const prevMonthDate = new Date(
      Date.UTC(currentYear, now.getUTCMonth() - 1, 1)
    );
    const prevMonthYear = prevMonthDate.getUTCFullYear();
    const prevMonth = prevMonthDate.getUTCMonth() + 1;

    const thisMonthRow = data.monthly.find(
      (r) => r.year === currentYear && r.month === currentMonth
    );
    const prevMonthRow = data.monthly.find(
      (r) => r.year === prevMonthYear && r.month === prevMonth
    );
    const sameMonthLastYearRow = data.monthly.find(
      (r) => r.year === currentYear - 1 && r.month === currentMonth
    );

    const thisYearRow = data.yearly.find((r) => r.year === currentYear);
    const lastYearRow = data.yearly.find((r) => r.year === currentYear - 1);

    const thisMonthCount = thisMonthRow?.count ?? 0;
    const prevMonthCount = prevMonthRow?.count ?? 0;
    const sameMonthLastYearCount = sameMonthLastYearRow?.count ?? 0;
    const thisYearCount =
      thisYearRow?.count ??
      data.monthly
        .filter((r) => r.year === currentYear)
        .reduce((sum, r) => sum + r.count, 0);

    const totalAllTime = data.yearly.reduce((sum, r) => sum + r.count, 0);

    // Peak year and peak month
    const sortedYearsDesc = [...data.yearly].sort((a, b) => b.count - a.count);
    const peakYear = sortedYearsDesc[0];

    const sortedMonthsDesc = [...data.monthly].sort(
      (a, b) => b.count - a.count
    );
    const peakMonth = sortedMonthsDesc[0];

    // Completed months average (excluding current partial month and Dec 2018 launch month)
    const completedMonths = data.monthly.filter(
      (r) =>
        !(r.year === currentYear && r.month === currentMonth) &&
        !(r.year === 2018 && r.month === 12)
    );
    const avgPerMonth =
      completedMonths.length > 0
        ? Math.round(
            completedMonths.reduce((sum, r) => sum + r.count, 0) /
              completedMonths.length
          )
        : 0;

    // Top 5 months
    const topMonthsText = sortedMonthsDesc
      .slice(0, 5)
      .map(
        (m, idx) =>
          `**${idx + 1}.** ${formatMonthYear(m.year, m.month, true)} — **${m.count.toLocaleString()}**`
      )
      .join("\n");

    // Yearly breakdown bar chart
    const maxYearCount = peakYear?.count || 1;
    const barWidth = 12;
    const yearlyChartLines = [...data.yearly]
      .sort((a, b) => a.year - b.year)
      .map((y) => {
        const filled = Math.max(
          1,
          Math.round((y.count / maxYearCount) * barWidth)
        );
        const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
        const suffix = y.year === currentYear ? " (YTD)" : "";
        const countStr = y.count.toLocaleString().padStart(5, " ");
        return `${y.year} ${bar} ${countStr}${suffix}`;
      })
      .join("\n");

    // YoY delta for current month
    let monthComparison = `Last month (${formatMonthYear(prevMonthYear, prevMonth, true)}): **${prevMonthCount.toLocaleString()}**`;
    if (sameMonthLastYearRow) {
      const diff = thisMonthCount - sameMonthLastYearCount;
      const sign = diff >= 0 ? "+" : "";
      monthComparison += `\n${formatMonthYear(currentYear - 1, currentMonth, true)}: **${sameMonthLastYearCount.toLocaleString()}** (${sign}${diff.toLocaleString()})`;
    }

    const embed = new EmbedBuilder()
      .setTitle(
        isCreations
          ? "Epic Games Store — Base Game Creation Stats"
          : "Epic Games Store — Base Game Release Stats"
      )
      .setURL("https://egdata.app/stats/releases")
      .setDescription(
        isCreations
          ? "Base game offers created on the Epic Games Store since launch (Dec 2018), excluding pre-purchases and code-redemption-only offers."
          : "Base games released on the Epic Games Store since launch (Dec 2018), excluding pre-purchases and code-redemption-only offers."
      )
      .setColor(0x00b4d8)
      .addFields([
        {
          name: `📅 This Month (${formatMonthYear(currentYear, currentMonth, true)})`,
          value: `**${thisMonthCount.toLocaleString()}** ${noun} so far\n${monthComparison}`,
          inline: true,
        },
        {
          name: `📆 This Year (${currentYear} YTD)`,
          value: `**${thisYearCount.toLocaleString()}** ${noun} so far${
            lastYearRow
              ? `\nFull ${currentYear - 1}: **${lastYearRow.count.toLocaleString()}**`
              : ""
          }\nAvg/month: **~${avgPerMonth.toLocaleString()}**`,
          inline: true,
        },
        {
          name: "🌐 All-Time Total",
          value: `**${totalAllTime.toLocaleString()}** base games\nTracked across **${data.monthly.length}** months`,
          inline: true,
        },
        {
          name: "🏆 Peak Year",
          value: peakYear
            ? `**${peakYear.year}** with **${peakYear.count.toLocaleString()}** ${noun}${
                peakYear.year === currentYear ? " (so far)" : ""
              }`
            : "N/A",
          inline: true,
        },
        {
          name: "🔥 Peak Month",
          value: peakMonth
            ? `**${formatMonthYear(peakMonth.year, peakMonth.month)}** with **${peakMonth.count.toLocaleString()}** ${noun}`
            : "N/A",
          inline: true,
        },
        {
          name: "📈 Top 5 Months",
          value: topMonthsText || "N/A",
          inline: true,
        },
        {
          name: "📊 Yearly Breakdown",
          value: `\`\`\`\n${yearlyChartLines}\n\`\`\``,
          inline: false,
        },
      ])
      .setTimestamp()
      .setFooter({ text: "Powered by egdata.app" });

    await interaction.editReply({
      embeds: [embed],
    });
  }
}

export default new ReleaseStatsCommand();
