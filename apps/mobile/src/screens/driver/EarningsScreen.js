/**
 * Earnings and the commission ledger (spec §8).
 *
 * "The owner should never need to ask what they owe."
 *
 * So this is shaped like a bank statement, because that is the shape people
 * already know how to read: opening balance, what went on, what came off,
 * closing balance. Every commission line names the trip it came from and the
 * fare it was 10% of, so a disagreement can be settled by pointing at a row
 * rather than by arguing about a total.
 *
 * Paying is a receipt upload, not a payment (spec §8, step 4). Wantok Ride
 * does not take money in the app. The owner transfers by bank or mobile money,
 * photographs the receipt, and an admin matches it against the statement — at
 * which point the vehicle relists itself automatically.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Image, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';

import {
  EntryType,
  buildStatement,
  ceilingState,
  formatKina,
  rebuildBalance,
  signOf,
  weekStart,
} from '@wantok/core';

import { Screen, ScreenHeader, Sheet } from '../../components/Chrome';
import { Card, EmptyState, Pill, SectionTitle } from '../../components/Bits';
import Button from '../../components/Button';
import { TextField } from '../../components/Forms';
import * as api from '../../services/supabase';
import { useApp } from '../../state/AppState';
import { colors, radius, spacing, type } from '../../theme';

const METHODS = [
  { code: 'BANK_TRANSFER', label: 'Bank transfer', icon: 'business-outline' },
  { code: 'MOBILE_MONEY', label: 'Mobile money', icon: 'phone-portrait-outline' },
];

export default function EarningsScreen({ navigation, route }) {
  const { vehicle: myVehicle, owner, profile } = useApp();
  const vehicleId = route.params?.vehicleId ?? myVehicle?.id;

  const [vehicle, setVehicle] = useState(myVehicle ?? null);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [payOpen, setPayOpen] = useState(false);

  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('BANK_TRANSFER');
  const [reference, setReference] = useState('');
  const [receipt, setReceipt] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!vehicleId) return;
    setLoading(true);
    try {
      const [v, rows] = await Promise.all([api.getVehicle(vehicleId), api.getLedger(vehicleId)]);
      setVehicle(v);
      setEntries(rows);
    } catch {
      setError('Could not load your ledger.');
    } finally {
      setLoading(false);
    }
  }, [vehicleId]);

  useEffect(() => {
    load();
  }, [load]);

  const { balance, entries: running } = useMemo(() => rebuildBalance(entries), [entries]);
  const statement = useMemo(
    () => (vehicle ? buildStatement({ entries, from: weekStart(new Date()), to: new Date(), vehicle }) : null),
    [entries, vehicle],
  );

  const pickReceipt = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      setError('Camera access is needed to photograph the receipt.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.6, allowsEditing: false });
    if (!result.canceled) setReceipt(result.assets[0]);
  };

  const submitPayment = async () => {
    const toea = Math.round(Number(amount) * 100);
    if (!Number.isFinite(toea) || toea <= 0) {
      setError('Enter the amount you paid');
      return;
    }
    if (!receipt) {
      setError('Photograph the receipt so we can match it to the bank statement');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const path = `${profile.id}/receipt-${Date.now()}.jpg`;
      const blob = await (await fetch(receipt.uri)).blob();
      await api.uploadDocument('receipts', path, blob, 'image/jpeg');
      await api.submitPayment({
        ownerId: owner.id,
        vehicleId: vehicle.id,
        amount: toea,
        method,
        reference: reference.trim() || null,
        receiptPath: path,
      });
      setPayOpen(false);
      setAmount('');
      setReference('');
      setReceipt(null);
      load();
    } catch (e) {
      setError('Could not send the receipt. Try again when you have signal.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!vehicleId) {
    return (
      <Screen>
        <ScreenHeader title="Earnings" onBack={navigation.goBack} />
        <EmptyState icon="wallet-outline" title="No vehicle" message="Earnings appear once you are driving an approved vehicle." />
      </Screen>
    );
  }

  const state = vehicle ? ceilingState(balance, vehicle.commission_ceiling) : null;

  return (
    <Screen>
      <ScreenHeader
        title="Commission"
        subtitle={vehicle?.registration_no}
        onBack={navigation.goBack}
      />

      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.ink} />}
      >
        <Card
          style={[
            styles.balanceCard,
            state?.state === 'OVER' && styles.over,
            state?.state === 'WARN' && styles.warn,
          ]}
        >
          <Text style={[type.caption, styles.muted]}>YOU OWE WANTOK RIDE</Text>
          <Text style={styles.bigBalance}>{formatKina(balance)}</Text>
          {state ? (
            <Pill
              label={
                state.state === 'OVER'
                  ? 'VEHICLE SUSPENDED'
                  : state.state === 'WARN'
                    ? `${formatKina(state.remaining)} BEFORE SUSPENSION`
                    : `LIMIT ${formatKina(state.ceiling)}`
              }
              tone={state.state === 'OVER' ? 'danger' : state.state === 'WARN' ? 'warning' : 'neutral'}
            />
          ) : null}
          {balance > 0 ? (
            <Button label="I have paid — send receipt" onPress={() => setPayOpen(true)} style={{ marginTop: spacing.lg }} />
          ) : null}
        </Card>

        {statement ? (
          <>
            <SectionTitle>THIS WEEK</SectionTitle>
            <Card>
              <StatementLine label="Opening balance" value={formatKina(statement.openingBalance)} />
              <StatementLine label={`Trips (${statement.trips})`} value={formatKina(statement.grossFares)} muted />
              <StatementLine label="Commission charged" value={`+${formatKina(statement.commissionCharged)}`} />
              <StatementLine label="Payments received" value={`−${formatKina(statement.paymentsReceived)}`} />
              <StatementLine label="Closing balance" value={formatKina(statement.closingBalance)} bold />
            </Card>
          </>
        ) : null}

        <SectionTitle>EVERY ENTRY</SectionTitle>
        {running.length ? (
          <Card style={{ paddingVertical: 0 }}>
            {[...running].reverse().map((entry, i) => (
              <View key={entry.id ?? i} style={[styles.entry, i === 0 && { borderTopWidth: 0 }]}>
                <View style={styles.entryIcon}>
                  <Ionicons
                    name={entry.entry_type === EntryType.COMMISSION ? 'car-outline' : 'cash-outline'}
                    size={16}
                    color={entry.entry_type === EntryType.COMMISSION ? colors.ink : colors.success}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={type.bodyStrong}>
                    {entry.entry_type === EntryType.COMMISSION
                      ? entry.amount === 0
                        ? 'Trip — free period'
                        : `Commission on ${formatKina(entry.gross_fare ?? 0)} fare`
                      : entry.entry_type === EntryType.PAYMENT
                        ? 'Payment received'
                        : entry.entry_type}
                  </Text>
                  <Text style={[type.caption, styles.muted]}>
                    {new Date(entry.created_at).toLocaleDateString('en-AU', {
                      day: 'numeric',
                      month: 'short',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                    {entry.note ? ` · ${entry.note}` : ''}
                  </Text>
                </View>
                <View style={styles.entryRight}>
                  <Text
                    style={[
                      type.bodyStrong,
                      { color: signOf(entry.entry_type) > 0 ? colors.text : colors.success },
                    ]}
                  >
                    {signOf(entry.entry_type) > 0 ? '+' : '−'}
                    {formatKina(entry.amount)}
                  </Text>
                  <Text style={[type.caption, styles.muted]}>{formatKina(entry.balance_after)}</Text>
                </View>
              </View>
            ))}
          </Card>
        ) : (
          <EmptyState icon="receipt-outline" title="Nothing yet" message="Commission appears here as you complete trips." />
        )}
      </ScrollView>

      <Sheet
        visible={payOpen}
        onClose={() => setPayOpen(false)}
        title="Send a payment receipt"
        subtitle="We check it against the bank statement, then your balance clears and your vehicle relists."
        footer={<Button label="Send receipt" onPress={submitPayment} loading={submitting} />}
      >
        <View style={styles.methodRow}>
          {METHODS.map((m) => (
            <Card
              key={m.code}
              style={[styles.method, method === m.code && styles.methodOn]}
              onPress={() => setMethod(m.code)}
            >
              <Ionicons name={m.icon} size={20} color={method === m.code ? colors.ink : colors.grey} />
              <Text style={[type.small, { marginTop: 4 }]}>{m.label}</Text>
            </Card>
          ))}
        </View>

        <TextField
          label="Amount paid (kina)"
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          placeholder={String((balance / 100).toFixed(2))}
          icon="cash-outline"
        />
        <TextField
          label="Reference"
          value={reference}
          onChangeText={setReference}
          placeholder="BSP transfer number"
          hint="Optional, but it makes matching much faster."
        />

        {receipt ? (
          <View style={styles.receiptPreview}>
            <Image source={{ uri: receipt.uri }} style={styles.receiptImage} />
            <Button label="Retake" variant="outline" small onPress={pickReceipt} />
          </View>
        ) : (
          <Button label="Photograph the receipt" variant="outline" icon="camera-outline" onPress={pickReceipt} />
        )}

        {error ? <Text style={[type.small, styles.error]}>{error}</Text> : null}
      </Sheet>
    </Screen>
  );
}

function StatementLine({ label, value, bold, muted }) {
  return (
    <View style={styles.statementLine}>
      <Text style={[bold ? type.bodyStrong : type.body, muted && styles.muted]}>{label}</Text>
      <Text style={[bold ? type.h3 : type.body, muted && styles.muted]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { padding: spacing.lg, paddingBottom: spacing.xxxl },
  muted: { color: colors.textMuted },
  error: { color: colors.danger, marginTop: spacing.md },

  balanceCard: { alignItems: 'center' },
  over: { backgroundColor: colors.dangerSoft, borderColor: colors.danger },
  warn: { backgroundColor: colors.warningSoft, borderColor: colors.warning },
  bigBalance: { fontSize: 42, lineHeight: 50, fontWeight: '800', color: colors.text, marginVertical: 4 },

  statementLine: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
  },

  entry: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  entryIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  entryRight: { alignItems: 'flex-end' },

  methodRow: { flexDirection: 'row', marginBottom: spacing.lg },
  method: { flex: 1, alignItems: 'center', marginRight: spacing.sm, paddingVertical: spacing.md },
  methodOn: { borderColor: colors.ink, backgroundColor: colors.surfaceAlt },

  receiptPreview: { alignItems: 'center' },
  receiptImage: {
    width: '100%',
    height: 180,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
    backgroundColor: colors.surfaceAlt,
  },
});
