/**
 * Quota USED, beside the chat's Bearings and Ahoy buttons: an icon and the
 * percent of the session (five-hour) window for each provider in Usage
 * Monitor's readings (Codex, Claude, then any other). Pressing it opens a
 * small card below with session and weekly use, reset times and freshness.
 * The numbers come from the daemon's read of Usage Monitor's saved readings
 * (server/quota.ts); this never calls a vendor.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { AppState, Image, Pressable, Text, View } from "react-native";

import {
  QUOTA_POLL_MS,
  QUOTA_QUERY_KEY,
  freshnessWords,
  isKnownQuotaProvider,
  providerName,
  quotaCells,
  quotaProviders,
  readQuota,
  type QuotaProviderId,
  type QuotaTone,
  type QuotaWindow,
} from "../shared/quota";
import { QUOTA_LOGOS } from "../shared/quota-logos";

const ICON_SIZE = 14;
// One source object per provider: a new one each render makes the image reload.
const LOGO_SOURCES = {
  claude: { uri: QUOTA_LOGOS.claude },
  codex: { uri: QUOTA_LOGOS.codex },
};

/**
 * The provider's mark, tinted like the text beside it; a provider without one
 * gets its initial in a small ring. Hidden from screen readers: the label
 * names the provider in words.
 */
function ProviderIcon({ id, color, size = ICON_SIZE }: { id: QuotaProviderId; color: string; size?: number }) {
  if (!isKnownQuotaProvider(id)) {
    return (
      <View
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: 1,
          borderColor: color,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color, fontSize: size * 0.6, fontWeight: "600", lineHeight: size - 2 }}>
          {providerName(id).charAt(0).toUpperCase()}
        </Text>
      </View>
    );
  }
  return (
    <Image
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      accessibilityIgnoresInvertColors
      source={LOGO_SOURCES[id]}
      style={{ width: size, height: size, tintColor: color }}
      resizeMode="contain"
    />
  );
}

function resetText(resetsAt: string | null): string {
  if (resetsAt === null) return "reset unknown";
  const at = new Date(resetsAt);
  return Number.isNaN(at.getTime()) ? "reset unknown" : `resets ${at.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
}

function windowText(window: QuotaWindow | null): string {
  return window === null ? "—" : `${Math.round(window.usedPercent)}% used · ${resetText(window.resetsAt)}`;
}

export function QuotaPill({ theme }: { theme: PluginTheme }) {
  const colors = theme.colors;
  const read = useRpc(readQuota);
  const [open, setOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const query = useQuery({
    queryKey: QUOTA_QUERY_KEY,
    queryFn: () => read({}),
    refetchInterval: QUOTA_POLL_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  const { refetch, dataUpdatedAt } = query;

  // Coming back to the foreground re-reads at once; the ages tick with each read.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refetch();
    });
    return () => subscription.remove();
  }, [refetch]);
  useEffect(() => setNowMs(Date.now()), [dataUpdatedAt]);
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), QUOTA_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const styles = useMemo(
    () => ({
      pill: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        minHeight: 28,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
      },
      text: { fontSize: 12, fontWeight: "500" as const },
      cell: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4 },
      titleRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      card: {
        width: "100%" as const,
        gap: 4,
        padding: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
      },
      title: { color: colors.foreground, fontSize: 12, fontWeight: "600" as const },
      line: { color: colors.foregroundMuted, fontSize: 11 },
    }),
    [colors],
  );
  const toneColor: Record<QuotaTone, string> = {
    normal: colors.foreground,
    muted: colors.foregroundMuted,
    warning: colors.statusWarning,
    danger: colors.statusDanger,
  };

  const snapshot = query.data;
  if (snapshot === undefined && !query.isError) {
    return (
      <View style={styles.pill} accessibilityLabel="Quota loading">
        <Text style={[styles.text, { color: colors.foregroundMuted }]}>Quota …</Text>
      </View>
    );
  }
  if (snapshot === undefined || snapshot.state === "unavailable") {
    return (
      <View style={styles.pill} accessibilityLabel="Quota unavailable">
        <Text style={[styles.text, { color: colors.foregroundMuted }]}>Quota unavailable</Text>
      </View>
    );
  }

  const cells = quotaCells(snapshot, nowMs);
  if (cells.length === 0) {
    return (
      <View style={styles.pill} accessibilityLabel="Quota: no providers in Usage Monitor's readings">
        <Text style={[styles.text, { color: colors.foregroundMuted }]}>Quota —</Text>
      </View>
    );
  }
  return (
    <>
      <Pressable
        style={styles.pill}
        accessibilityRole="button"
        accessibilityLabel={`Quota used. ${cells.map((cell) => cell.label).join(". ")}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((was) => !was)}
      >
        {cells.map((cell, index) => (
          <View key={cell.id} style={styles.cell}>
            {index === 0 ? null : <Text style={[styles.text, { color: colors.foregroundMuted }]}>{" · "}</Text>}
            <ProviderIcon id={cell.id} color={toneColor[cell.tone]} />
            <Text style={[styles.text, { color: toneColor[cell.tone] }]}>{cell.text}</Text>
          </View>
        ))}
      </Pressable>
      {open ? (
        <View style={styles.card}>
          {quotaProviders(snapshot).map((provider) => (
            <View key={provider.id}>
              <View style={styles.titleRow}>
                <ProviderIcon id={provider.id} color={colors.foreground} />
                <Text style={styles.title}>{providerName(provider.id)}</Text>
              </View>
              <Text style={styles.line}>Session: {windowText(provider.session)}</Text>
              <Text style={styles.line}>Weekly: {windowText(provider.weekly)}</Text>
              <Text style={styles.line}>{freshnessWords(provider.id, provider.fetchedAt, nowMs)}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </>
  );
}
