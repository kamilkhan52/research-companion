// M4 — the paywall, driven entirely by the CURRENT Offering from RevenueCat (roadmap: "via
// the current Offering rather than hardcoded product logic"): packages, prices, and copy
// order come from the dashboard, so pricing experiments never need an app release.
//
// Reachable only from the Plan screen's dev-gated Upgrade row until M5 lands server-side
// entitlement enforcement — the flag the roadmap's rollback plan calls for. Every state this
// screen can be in renders something honest:
//   - billing unavailable (native module absent in this build, or no SDK key) — say so;
//   - offerings fetch failed or empty (dashboard not authored yet) — say so, offer retry;
//   - purchase flows end in purchased / cancelled / error, each with its own copy.
// Restore Purchases is always present when billing works: it is the Play-required recovery
// path for a fresh install finding its existing subscription.

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import type { PurchasesOffering, PurchasesPackage } from 'react-native-purchases';

import { TopBar } from '@/components/TopBar';
import {
  billingAvailable,
  currentOffering,
  purchase,
  restore,
} from '@/purchases/purchases';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';
import { space, type ThemePalette } from '@/theme/tokens';
import { Button, Card, Screen, Text, ToneIcon, ToneSurface } from '@/ui';
import { showToast } from '@/ui/Toast';

/** Dashboard packageType → reader-facing label; identifier fallback for custom packages. */
function packageLabel(pkg: PurchasesPackage): string {
  switch (pkg.packageType) {
    case 'MONTHLY': return 'Monthly';
    case 'ANNUAL': return 'Annual';
    default: return pkg.identifier.replace(/^\$rc_/, '');
  }
}

export default function PaywallScreen() {
  const router = useRouter();
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [offering, setOffering] = useState<PurchasesOffering | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null); // package identifier mid-purchase
  const [restoring, setRestoring] = useState(false);

  const available = billingAvailable();

  const load = useCallback(async () => {
    setLoading(true);
    setOffering(await currentOffering());
    setLoading(false);
  }, []);

  useEffect(() => {
    if (available) void load();
    else setLoading(false);
  }, [available, load]);

  const buy = useCallback(async (pkg: PurchasesPackage) => {
    setBusy(pkg.identifier);
    const result = await purchase(pkg);
    setBusy(null);
    if (result.status === 'purchased') {
      // Deliberately no Plan-screen refresh: the server's plan does not move until M5's
      // entitlement wiring lands — refreshing would imply it should have changed.
      showToast('Subscription active. Thank you!');
      router.back();
    } else if (result.status === 'error') {
      showToast(result.message);
    }
    // 'cancelled' is silent — the reader changed their mind; nothing to announce.
  }, [router]);

  const onRestore = useCallback(async () => {
    setRestoring(true);
    const result = await restore();
    setRestoring(false);
    if (result.status === 'restored') {
      showToast(result.active
        ? 'Subscription restored.'
        : 'No previous subscription found for this account.');
    } else if (result.status === 'error') {
      showToast(result.message);
    }
  }, []);

  return (
    <Screen>
      <TopBar title="Upgrade" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.content}>
        {!available ? (
          <ToneSurface tone="neutral" style={styles.stateCard}>
            <ToneIcon name="credit-card" />
            <Text variant="heading" style={styles.stateTitle}>Billing isn't available in this build</Text>
            <Text variant="body" color={t.muted} style={styles.stateBody}>
              This installation doesn't include the store billing module yet. A rebuilt app
              from the store (or a fresh development build) is required before subscriptions
              can be purchased here.
            </Text>
          </ToneSurface>
        ) : loading ? (
          <Text variant="body" color={t.muted}>Loading plans…</Text>
        ) : !offering || offering.availablePackages.length === 0 ? (
          <ToneSurface tone="neutral" style={styles.stateCard}>
            <ToneIcon name="credit-card" />
            <Text variant="heading" style={styles.stateTitle}>Plans aren't available right now</Text>
            <Text variant="body" color={t.muted} style={styles.stateBody}>
              No subscription products are configured yet, or they couldn't be loaded. Nothing
              is wrong with your account.
            </Text>
            <Button title="Try again" variant="ghost" onPress={() => void load()} style={styles.stateAction} />
          </ToneSurface>
        ) : (
          <>
            <View style={styles.hero}>
              <Text variant="overline" color={t.violet}>SCHOLIAST</Text>
              <Text variant="editorial" style={styles.heroTitle}>Read more, every month</Text>
              <Text variant="body" color={t.muted} style={styles.heroBody}>
                A larger monthly allowance for the analysis and narration that support your
                reading.
              </Text>
            </View>
            {offering.availablePackages.map((pkg) => (
              <Card key={pkg.identifier} style={styles.packageCard}>
                <View style={styles.packageRow}>
                  <View style={{ flex: 1 }}>
                    <Text variant="heading">{packageLabel(pkg)}</Text>
                    <Text variant="caption" color={t.muted}>{pkg.product.title}</Text>
                  </View>
                  <Text variant="heading">{pkg.product.priceString}</Text>
                </View>
                <Button
                  title={`Subscribe ${packageLabel(pkg).toLowerCase()}`}
                  loading={busy === pkg.identifier}
                  disabled={busy !== null}
                  onPress={() => void buy(pkg)}
                  style={styles.packageAction}
                />
              </Card>
            ))}
            <Button
              title="Restore purchases"
              variant="ghost"
              loading={restoring}
              disabled={restoring}
              onPress={() => void onRestore()}
            />
            <Text variant="caption" color={t.muted} style={styles.footnote}>
              Subscriptions are billed and managed by Google Play. Cancel anytime from the
              Play Store; access continues until the end of the paid period.
            </Text>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const makeStyles = (t: ThemePalette) => StyleSheet.create({
  content: { padding: space.lg, gap: space.md, paddingBottom: space.xl },
  hero: { marginBottom: space.sm },
  heroTitle: { marginTop: 2 },
  heroBody: { marginTop: space.xs },
  stateCard: { alignItems: 'center', padding: space.lg },
  stateTitle: { marginTop: space.sm, textAlign: 'center' },
  stateBody: { marginTop: space.xs, textAlign: 'center' },
  stateAction: { marginTop: space.sm },
  packageCard: { gap: space.sm },
  packageRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  packageAction: { marginTop: space.xs },
  footnote: { textAlign: 'center', marginTop: space.sm },
});
