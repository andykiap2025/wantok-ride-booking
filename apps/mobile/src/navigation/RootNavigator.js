/**
 * Navigation.
 *
 * One codebase, two Play Store listings. `EXPO_PUBLIC_VARIANT` selects which
 * shell mounts — customer or driver — and they share the domain engine, the
 * design system, the Supabase client, chat, rating and SOS. Only the
 * navigator differs.
 *
 * Two things are load-bearing here and are worth stating:
 *
 *   1. **Signed out, signed in and set-up are three different trees.** A user
 *      who has not verified an emergency contact cannot navigate past it,
 *      because it is not on the stack behind them — spec §10 makes it
 *      mandatory before an account can book or drive, and a "skip" that exists
 *      anywhere in the navigator is a skip someone will find.
 *
 *   2. **The driver's incoming-request screen is opened by a push, not by
 *      browsing.** A 90-second window does not survive being a tab.
 */

import React, { useEffect, useRef } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { NavigationContainer, useNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createDrawerNavigator } from '@react-navigation/drawer';
import { StatusBar } from 'expo-status-bar';

import { emergencyContactComplete } from '@wantok/core';

import { IS_DRIVER_APP } from '../services/config';
import { useApp } from '../state/AppState';
import { colors } from '../theme';
import DrawerContent from './DrawerContent';

// Onboarding and auth
import OnboardingScreen from '../screens/onboarding/OnboardingScreen';
import WelcomeScreen from '../screens/onboarding/WelcomeScreen';
import PhoneScreen from '../screens/auth/PhoneScreen';
import VerifyScreen from '../screens/auth/VerifyScreen';
import ProfileSetupScreen from '../screens/auth/ProfileSetupScreen';
import EmergencyContactScreen from '../screens/auth/EmergencyContactScreen';

// Customer
import HomeScreen from '../screens/customer/HomeScreen';
import DestinationScreen from '../screens/customer/DestinationScreen';
import PickOnMapScreen from '../screens/customer/PickOnMapScreen';
import ScheduleScreen from '../screens/customer/ScheduleScreen';
import VehicleListScreen from '../screens/customer/VehicleListScreen';
import VehicleProfileScreen from '../screens/customer/VehicleProfileScreen';
import WaitingScreen from '../screens/customer/WaitingScreen';
import TripScreen from '../screens/customer/TripScreen';
import MyRidesScreen from '../screens/customer/MyRidesScreen';

// Driver and owner
import DriverHomeScreen from '../screens/driver/DriverHomeScreen';
import RequestScreen from '../screens/driver/RequestScreen';
import DriverTripScreen from '../screens/driver/DriverTripScreen';
import EarningsScreen from '../screens/driver/EarningsScreen';
import OwnerVehiclesScreen from '../screens/owner/OwnerVehiclesScreen';
import AddVehicleScreen from '../screens/owner/AddVehicleScreen';

// Shared
import ChatScreen from '../screens/shared/ChatScreen';
import RateScreen from '../screens/shared/RateScreen';
import ProfileScreen from '../screens/shared/ProfileScreen';
import ReceiptScreen from '../screens/shared/ReceiptScreen';

const Stack = createNativeStackNavigator();
const Drawer = createDrawerNavigator();

const hidden = { headerShown: false };

/** Not signed in. */
function AuthStack() {
  return (
    <Stack.Navigator screenOptions={hidden} initialRouteName="Onboarding">
      <Stack.Screen name="Onboarding" component={OnboardingScreen} />
      <Stack.Screen name="Welcome" component={WelcomeScreen} />
      <Stack.Screen name="Phone" component={PhoneScreen} />
      <Stack.Screen name="Verify" component={VerifyScreen} />
    </Stack.Navigator>
  );
}

/**
 * Signed in, but the account is not yet allowed to book or drive.
 *
 * There is no route out of here except by finishing. That is the point.
 */
function SetupStack() {
  return (
    <Stack.Navigator screenOptions={hidden}>
      <Stack.Screen name="ProfileSetup" component={ProfileSetupScreen} />
      <Stack.Screen name="EmergencyContact" component={EmergencyContactScreen} />
    </Stack.Navigator>
  );
}

function CustomerStack() {
  return (
    <Stack.Navigator screenOptions={hidden}>
      <Stack.Screen name="Home" component={HomeScreen} />
      <Stack.Screen name="Destination" component={DestinationScreen} />
      <Stack.Screen name="PickOnMap" component={PickOnMapScreen} />
      <Stack.Screen name="Schedule" component={ScheduleScreen} />
      <Stack.Screen name="Vehicles" component={VehicleListScreen} />
      <Stack.Screen name="VehicleProfile" component={VehicleProfileScreen} />
      {/* No gesture back: a live request is not something to swipe away from. */}
      <Stack.Screen name="Waiting" component={WaitingScreen} options={{ gestureEnabled: false }} />
      <Stack.Screen name="Trip" component={TripScreen} options={{ gestureEnabled: false }} />
      <Stack.Screen name="Complete" component={RateScreen} options={{ gestureEnabled: false }} />
      <Stack.Screen name="Chat" component={ChatScreen} />
      <Stack.Screen name="MyRides" component={MyRidesScreen} />
      <Stack.Screen name="Receipt" component={ReceiptScreen} />
      <Stack.Screen name="Profile" component={ProfileScreen} />
      <Stack.Screen name="EmergencyContact" component={EmergencyContactScreen} />
    </Stack.Navigator>
  );
}

function DriverStack() {
  return (
    <Stack.Navigator screenOptions={hidden}>
      <Stack.Screen name="DriverHome" component={DriverHomeScreen} />
      <Stack.Screen name="Request" component={RequestScreen} options={{ gestureEnabled: false }} />
      <Stack.Screen name="DriverTrip" component={DriverTripScreen} options={{ gestureEnabled: false }} />
      <Stack.Screen name="DriverRate" component={RateScreen} options={{ gestureEnabled: false }} />
      <Stack.Screen name="Earnings" component={EarningsScreen} />
      <Stack.Screen name="OwnerVehicles" component={OwnerVehiclesScreen} />
      <Stack.Screen name="AddVehicle" component={AddVehicleScreen} />
      <Stack.Screen name="Receipt" component={ReceiptScreen} />
      <Stack.Screen name="Chat" component={ChatScreen} />
      <Stack.Screen name="Profile" component={ProfileScreen} />
      <Stack.Screen name="EmergencyContact" component={EmergencyContactScreen} />
    </Stack.Navigator>
  );
}

function MainDrawer() {
  return (
    <Drawer.Navigator
      screenOptions={{ ...hidden, drawerType: 'front', drawerStyle: { width: 300 } }}
      drawerContent={(props) => <DrawerContent {...props} />}
    >
      <Drawer.Screen name="App" component={IS_DRIVER_APP ? DriverStack : CustomerStack} />
    </Drawer.Navigator>
  );
}

export default function RootNavigator() {
  const { status, profile, driver } = useApp();
  const navigationRef = useNavigationContainerRef();

  if (status === 'LOADING') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.ink} />
      </View>
    );
  }

  // Spec §10: no booking and no driving without a verified emergency contact.
  const setupDone = profile?.full_name && emergencyContactComplete(profile);

  return (
    <NavigationContainer ref={navigationRef}>
      <StatusBar style="dark" />
      {status !== 'SIGNED_IN' ? (
        <AuthStack />
      ) : !setupDone ? (
        <SetupStack />
      ) : (
        <MainDrawer />
      )}
    </NavigationContainer>
  );
}
