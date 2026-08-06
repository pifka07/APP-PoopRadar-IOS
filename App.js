// URL-Polyfill für Supabase Realtime (MUSS GANZ OBEN STEHEN)
import 'react-native-url-polyfill/auto';

import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Alert, ActivityIndicator, TextInput, Vibration, ScrollView, FlatList, Modal, Platform, KeyboardAvoidingView, Linking, Switch } from 'react-native';
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps';
import * as Location from 'expo-location';
import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audio } from 'expo-av';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import { BannerAd, BannerAdSize } from 'react-native-google-mobile-ads';
import { datenschutzText, impressumText } from './legalTexts';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// --- SUPABASE SETUP ---
const supabaseUrl = 'https://jpzkqatezxnbawcsvgux.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpwemtxYXRlenhuYmF3Y3N2Z3V4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyNTQ3MTMsImV4cCI6MjA4ODgzMDcxM30._w0GheLM-aTWGdA6hsozokTAgdUOUlwsqEflgCC-xiU'; 

const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

const REPORT_VIBRATION_STORAGE_KEY = 'reportFeedback.vibrationEnabled';
const REPORT_SOUND_STORAGE_KEY = 'reportFeedback.soundEnabled';

const REPORT_TYPE_OPTIONS = [
  {
    id: 'POOP',
    label: 'Haufen',
    shortLabel: 'Haufen',
    icon: '💩',
    markerSize: 26,
    markerBg: '#FFE8CC',
    markerBorder: '#C97818',
  },
  {
    id: 'BIN_BAGS',
    label: 'Mülleimer / Hunde-Tüten',
    shortLabel: 'Tüten',
    icon: '\u{1F6CD}\uFE0F',
    markerSize: 22,
    markerBg: '#D9F2FF',
    markerBorder: '#0077B6',
  },
  {
    id: 'POISON',
    label: 'Giftköder',
    shortLabel: 'Giftköder',
    icon: '⚠️',
    markerSize: 22,
    markerBg: '#FFDDE6',
    markerBorder: '#B4234D',
  },
];

const REPORT_TYPE_EXPIRY_DAYS = {
  POOP: 8,
  BIN_BAGS: null,
  POISON: 10,
};

const getNormalizedReportType = (rawType) => {
  if (!rawType) return 'POOP';
  if (rawType === 'S' || rawType === 'M' || rawType === 'L') return 'POOP';
  if (rawType === 'POOP' || rawType === 'BIN_BAGS' || rawType === 'POISON') return rawType;
  return 'POOP';
};

const getReportTypeMeta = (rawType) => {
  const normalizedType = getNormalizedReportType(rawType);
  return REPORT_TYPE_OPTIONS.find((option) => option.id === normalizedType) || REPORT_TYPE_OPTIONS[0];
};

const isReportExpired = (report, nowMs = Date.now()) => {
  const normalizedType = getNormalizedReportType(report?.size);
  const expiryDays = REPORT_TYPE_EXPIRY_DAYS[normalizedType];

  if (!expiryDays) return false;

  const createdAtMs = report?.created_at ? new Date(report.created_at).getTime() : NaN;
  if (Number.isNaN(createdAtMs)) return false;

  return nowMs - createdAtMs > expiryDays * 24 * 60 * 60 * 1000;
};

export default function App() {
  const [session, setSession] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showAuth, setShowAuth] = useState(false);
  const [location, setLocation] = useState(null);
  const [currentCity, setCurrentCity] = useState("Ortung...");
  const [markers, setMarkers] = useState([]);
  const [cityStats, setCityStats] = useState([]);
  const [selectedSize, setSelectedSize] = useState('POOP');
  const [selectedPoop, setSelectedPoop] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('Radar');
  const [displayName, setDisplayName] = useState("Gast-Modus");
  const [isEditingName, setIsEditingName] = useState(false);
  const [editNameInput, setEditNameInput] = useState('');
  const [nickname, setNickname] = useState('');
  const [nicknameInput, setNicknameInput] = useState('');
  const [isEditingNickname, setIsEditingNickname] = useState(false);
  const [publishInList, setPublishInList] = useState(false);
  const [leaderboard, setLeaderboard] = useState([]);
  const [stats, setStats] = useState({ 
    points: 0, total: 0, clean: 0, poison: 0, bins: 0, cityCount: 0, sizeTypes: 0, level: 1, levelName: "Gehweg-Novize"
  });
  const [legalVisible, setLegalVisible] = useState(false);
  const [legalContent, setLegalContent] = useState({ title: '', text: '' });
  const [lastMarkerSyncTime, setLastMarkerSyncTime] = useState(null);
  const [notificationStatus, setNotificationStatus] = useState('unknown');
  const [pushTokenStatus, setPushTokenStatus] = useState('unbekannt');
  const [reportVibrationEnabled, setReportVibrationEnabled] = useState(true);
  const [reportSoundEnabled, setReportSoundEnabled] = useState(true);

  const registerPushToken = async (sess, attempt = 1) => {
    if (!sess?.user?.id) return;
    try {
      if (!Device.isDevice) {
        setPushTokenStatus('Kein echtes Geraet (Emulator)');
        return;
      }

      const permissionResult = await Notifications.getPermissionsAsync();
      let finalStatus = permissionResult.status;
      if (finalStatus !== 'granted') {
        const requestResult = await Notifications.requestPermissionsAsync();
        finalStatus = requestResult.status;
      }

      if (finalStatus !== 'granted') {
        setPushTokenStatus('Push-Berechtigung fehlt');
        return;
      }

      const easProjectId =
        Constants?.expoConfig?.extra?.eas?.projectId ||
        Constants?.easConfig?.projectId ||
        '744de408-fcd0-4202-a2f7-43fdeecf95c8';

      const tokenData = await Notifications.getExpoPushTokenAsync({
        projectId: easProjectId,
      });
      const expoPushToken = tokenData?.data;
      if (!expoPushToken) {
        setPushTokenStatus('Token leer');
        return;
      }

      const { error: tokenSaveError } = await supabase
        .from('profiles')
        .update({ expo_push_token: expoPushToken })
        .eq('id', sess.user.id);

      if (tokenSaveError) {
        setPushTokenStatus('Token speichern fehlgeschlagen');
        console.log('Push-Token DB-Fehler:', tokenSaveError);
        return;
      }

      setPushTokenStatus('aktiv');
      console.log('Push-Token gespeichert:', expoPushToken);
    } catch (e) {
      setPushTokenStatus(`Fehler (Versuch ${attempt})`);
      console.log('Push-Token konnte nicht gespeichert werden:', e);
      if (attempt < 3) {
        setTimeout(() => {
          registerPushToken(sess, attempt + 1).catch((retryError) => {
            console.log('Push-Token Retry fehlgeschlagen:', retryError);
          });
        }, 2500);
      }
    }
  };

  const updateProfileLocation = async (coords) => {
    const sess = sessionRef.current;
    if (!sess?.user?.id) return;
    try {
      await supabase
        .from('profiles')
        .update({
          last_lat: coords.latitude,
          last_lng: coords.longitude,
        })
        .eq('id', sess.user.id);
    } catch (e) {
      console.log('Standort-Update fehlgeschlagen:', e);
    }
  };

  const registerNotificationPermissions = async () => {
    try {
      const { status: existingStatus } = await Notifications.getPermissionsAsync();
      let finalStatus = existingStatus;

      if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }

      setNotificationStatus(finalStatus || 'denied');

      if (finalStatus !== 'granted') {
        console.log('Benachrichtigungen nicht erlaubt');
        return false;
      }

      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('poop-alerts', {
          name: 'Poop Radar Benachrichtigungen',
          importance: Notifications.AndroidImportance.HIGH,
          sound: 'default',
          vibrationPattern: [0, 250, 250, 250],
          lightColor: '#FF6600',
        });
      }

      return true;
    } catch (error) {
      console.log('Notification registration failed:', error);
      setNotificationStatus('denied');
      return false;
    }
  };

  const refreshNotificationStatus = async () => {
    try {
      const { status } = await Notifications.getPermissionsAsync();
      setNotificationStatus(status || 'denied');
    } catch (error) {
      console.log('Fehler beim Abfragen von Notification Permissions:', error);
      setNotificationStatus('denied');
    }
  };

  const openNotificationSettings = async () => {
    try {
      await Linking.openSettings();
    } catch (error) {
      console.log('Konnte Einstellungen nicht öffnen:', error);
      Alert.alert('Info', 'Bitte öffne die Benachrichtigungseinstellungen manuell.');
    }
  };

  const loadReportFeedbackSettings = async () => {
    try {
      const values = await AsyncStorage.multiGet([
        REPORT_VIBRATION_STORAGE_KEY,
        REPORT_SOUND_STORAGE_KEY,
      ]);
      const storedValues = Object.fromEntries(values);

      if (storedValues[REPORT_VIBRATION_STORAGE_KEY] !== null) {
        setReportVibrationEnabled(JSON.parse(storedValues[REPORT_VIBRATION_STORAGE_KEY]));
      }

      if (storedValues[REPORT_SOUND_STORAGE_KEY] !== null) {
        setReportSoundEnabled(JSON.parse(storedValues[REPORT_SOUND_STORAGE_KEY]));
      }
    } catch (error) {
      console.log('Fehler beim Laden der Feedback-Einstellungen:', error);
    }
  };

  const saveReportFeedbackSetting = async (storageKey, value, setter) => {
    setter(value);

    try {
      await AsyncStorage.setItem(storageKey, JSON.stringify(value));
    } catch (error) {
      console.log('Fehler beim Speichern der Feedback-Einstellung:', error);
    }
  };

  const triggerReportVibrationFeedback = () => {
    try {
      Vibration.cancel();
      Vibration.vibrate(180);
    } catch (vibError) {
      console.log('Vibration fehlgeschlagen:', vibError);
    }
  };

  const playReportFeedback = async () => {
    try {
      if (reportVibrationEnabled) {
        await triggerReportVibrationFeedback();
      }
    } catch (vibError) {
      console.log('Vibration-Fehler:', vibError);
    }

    if (!reportSoundEnabled) {
      return;
    }

    // Sound-Feedback asynchron abspielen (nicht warten)
    playReportSound();
  };

  const playReportSound = async () => {
    try {
      const { sound } = await Audio.Sound.createAsync(
        require('./assets/sounds/report-beep.wav'),
        { volume: 0.4, shouldPlay: false }
      );

      // Stelle sicher, dass die Audio-Session korrekt ist
      try {
        await Audio.setAudioModeAsync({
          playsInSilentModeIOS: true,
          staysActiveInBackground: false,
          shouldDuckAndroid: true,
        });
      } catch (audioModeError) {
        console.log('Audio-Mode Fehler (nicht kritisch):', audioModeError);
      }

      await sound.playAsync();

      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish) {
          sound.unloadAsync().catch(err => console.log('Sound cleanup error:', err));
        }
      });
    } catch (error) {
      console.log('Fehler beim Abspielen des Meldetons:', error);
    }
  };

  const badgeDefinitions = [
    { id: 'first-fund', title: 'Erster Haufen', subtitle: 'Ersten Haufen markiert', icon: '🎉', achieved: stats.total >= 1, accent: '#B58145', soft: '#F8ECDE' },
    { id: 'beginner', title: 'Anfaenger', subtitle: '50 Haufen-XP erreicht', icon: '⭐', achieved: stats.points >= 50, accent: '#E09B22', soft: '#FFF2DA' },
    { id: 'advanced', title: 'Fortgeschritten', subtitle: '200 Haufen-XP erreicht', icon: '🚀', achieved: stats.points >= 200, accent: '#C67C1F', soft: '#FEEBD5' },
    { id: 'expert', title: 'Experte', subtitle: '500 Haufen-XP erreicht', icon: '🏆', achieved: stats.points >= 500, accent: '#9A5B16', soft: '#F9E7D2' },
    { id: 'cleaner', title: 'Saubermann', subtitle: 'Erste Meldung entfernt', icon: '🧹', achieved: stats.clean >= 1, accent: '#3F9C66', soft: '#E2F4EA' },
    { id: 'hero', title: 'Held', subtitle: '25 Meldungen entfernt', icon: '🦸', achieved: stats.clean >= 25, accent: '#2C8D5A', soft: '#D9F0E4' },
    { id: 'bags-scout', title: 'Tüten-Scout', subtitle: 'Ersten Mülleimer/Tüten-Spender gemeldet', icon: '🗑️', achieved: stats.bins >= 1, accent: '#2F7D7A', soft: '#E0F1F0' },
    { id: 'poison-watch', title: 'Giftwarner', subtitle: 'Ersten Giftköder gemeldet', icon: '⚠️', achieved: stats.poison >= 1, accent: '#A4475D', soft: '#F7E4EA' },
    { id: 'collector', title: 'Sammler', subtitle: 'Haufen, Tüten und Giftköder gemeldet', icon: '🎯', achieved: stats.sizeTypes >= 3, accent: '#6D4BAE', soft: '#EFE8FA' },
    { id: 'globetrotter', title: 'Weltenbummler', subtitle: 'In 10 verschiedenen Städten gemeldet', icon: '🌍', achieved: stats.cityCount >= 10, accent: '#2F6EA3', soft: '#E1EDF8' },
    { id: 'legend', title: 'Legende', subtitle: '1000 Haufen-XP erreicht', icon: '👑', achieved: stats.points >= 1000, accent: '#8D5B2A', soft: '#F9E9D8' },
  ];

  const mapRef = useRef(null);
  const pendingRegionRef = useRef(null);
  const locationWatcher = useRef(null);
  const notifiedReportIds = useRef(new Set());
  const startupNearbyInfoShown = useRef(false);
  const locationRef = useRef(null);
  const notificationStatusRef = useRef('unknown');
  const lastMarkerSyncTimeRef = useRef(null);
  const sessionRef = useRef(null);
  const locationUpdateCounterRef = useRef(0);

  useEffect(() => {
    notificationStatusRef.current = notificationStatus;
  }, [notificationStatus]);

  useEffect(() => {
    let isMounted = true;

    const init = async () => {
      // Zuerst nur Session laden → Splash sofort beenden
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session && isMounted) {
          setSession(session);
        }
      } catch (err) {
        console.log("Startfehler:", err);
      } finally {
        if (isMounted) setIsLoading(false);
      }

      // Rest im Hintergrund (UI ist schon sichtbar)
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session && isMounted) {
          sessionRef.current = session;
          await updateProfileData(session);
        }
        await setupApp();
        await loadLeaderboard();
        if (sessionRef.current) {
          await registerPushToken(sessionRef.current);
        }
      } catch (err) {
        console.log("Startfehler (Hintergrund):", err);
      }
    };

    init();

    const channel = supabase
      .channel('schema-db-changes') // Eindeutiger Name
      .on('postgres_changes', 
        { event: '*', schema: 'public', table: 'reports' }, 
        async (payload) => {
          if (payload?.eventType === 'INSERT' && payload?.new) {
            await processReportForNotification(payload.new);
          }

          await checkNearbyReports();
          await fetchAllMarkers();
        }
      )
      .subscribe();

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      sessionRef.current = session;
      setSession(session);
      if (session) {
        updateProfileData(session);
        loadLeaderboard();
        registerPushToken(session).catch((e) => console.log('Push-Token Fehler:', e));
      }
    });

    return () => {
      isMounted = false;
      if (authListener?.subscription) authListener.subscription.unsubscribe();
      if (channel) supabase.removeChannel(channel);
      if (locationWatcher.current) locationWatcher.current.remove();
    };
  }, []);

  const updateProfileData = async (sess) => {
    if (!sess?.user) {
      setStats({ points: 0, total: 0, clean: 0, poison: 0, bins: 0, cityCount: 0, sizeTypes: 0, level: 1, levelName: "Gehweg-Novize", rank: '-', userCount: '-' });
      return;
    }

    await createProfileRowIfMissing(sess);

    try {
      let { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', sess.user.id)
        .single();

      if (error || !data) {
        const { data: newData, error: insertError } = await supabase
          .from('profiles')
          .insert([{ id: sess.user.id, points: 0, total_reports: 0, clean_count: 0 }])
          .select().single();
        if (insertError) return;
        data = newData;
      }

      const { count: higherRanked } = await supabase
        .from('profiles')
        .select('*', { count: 'exact', head: true })
        .gt('points', data.points || 0);

      const { count: totalUsers } = await supabase
        .from('profiles')
        .select('*', { count: 'exact', head: true });

      let poisonCount = 0;
      let binsCount = 0;
      let cityCount = 0;
      let sizeTypes = 0;

      let userReports;
      let reportsError;

      try {
        const result = await supabase
          .from('reports')
          .select('size, city')
          .eq('user_id', sess.user.id);
        userReports = result.data;
        reportsError = result.error;
      } catch (err) {
        reportsError = err;
      }

      if ((!userReports || reportsError)) {
        const result = await supabase.from('reports').select('size, city');
        userReports = result.data;
        reportsError = result.error;
      }

      if (userReports && !reportsError) {
        const cities = new Set();
        const sizes = new Set();

        userReports.forEach((report) => {
          const normalizedType = getNormalizedReportType(report?.size);
          if (report?.city) cities.add(report.city);
          sizes.add(normalizedType);
          if (normalizedType === 'POISON') poisonCount += 1;
          if (normalizedType === 'BIN_BAGS') binsCount += 1;
        });

        cityCount = cities.size;
        sizeTypes = sizes.size;
      }

      if (data) {
        setStats({
          points: data.points || 0,
          total: data.total_reports || 0,
          clean: data.clean_count || 0,
          poison: poisonCount,
          bins: binsCount,
          cityCount,
          sizeTypes,
          level: Math.floor((data.points || 0) / 100) + 1,
          levelName: (data.points || 0) > 500 ? "Haufen-Hunter" : "Gehweg-Novize",
          rank: (higherRanked || 0) + 1,
          userCount: totalUsers || 1
        });
        
        const metaName = sess.user.user_metadata?.display_name;
        const fallbackName = sess.user?.email ? sess.user.email.split('@')[0] : "User";
        setDisplayName(metaName || fallbackName);
        setNickname(data.nickname || '');
        setNicknameInput(data.nickname || '');
        setPublishInList(data.publish_in_list === true);
      }
    } catch (err) {
      console.log("Fehler beim Ranking-Check:", err);
    }
  };

  const deleteAccount = async () => {
    Alert.alert(
      "Account löschen",
      "Sind Sie sicher, dass Sie Ihren Account und alle Daten löschen möchten? Diese Aktion kann nicht rückgängig gemacht werden.",
      [
        { text: "Abbrechen", style: "cancel" },
        { text: "Löschen", style: "destructive", onPress: async () => {
          try {
            // Lösche alle Reports des Users
            await supabase.from('reports').delete().eq('user_id', session.user.id);
            // Lösche Profil
            await supabase.from('profiles').delete().eq('id', session.user.id);
            // Logout
            await supabase.auth.signOut();
            Alert.alert("Account gelöscht", "Ihr Account und alle Daten wurden erfolgreich gelöscht.");
          } catch (error) {
            console.log("Fehler beim Löschen:", error);
            Alert.alert("Fehler", "Beim Löschen ist ein Fehler aufgetreten.");
          }
        }}
      ]
    );
  };

  const setupApp = async () => {
    try {
      await registerNotificationPermissions();
      await refreshNotificationStatus();
      await loadReportFeedbackSettings();

      try {
        await Audio.setAudioModeAsync({
          playsInSilentModeIOS: true,
          staysActiveInBackground: false,
          shouldDuckAndroid: true,
        });
      } catch (audioError) {
        console.log('Audio-Modus konnte nicht gesetzt werden:', audioError);
      }

      let { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') { setIsLoading(false); return; }
      
      const currentLoc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setLocation(currentLoc.coords);
      locationRef.current = currentLoc.coords;
      try {
        let rev = await Location.reverseGeocodeAsync(currentLoc.coords);
        if (rev[0]?.city) {
          setCurrentCity(rev[0].city);
        }
      } catch (e) {
        console.log("Geocode Error:", e);
      }

      locationWatcher.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Balanced,
          distanceInterval: 10,
        },
        async (loc) => {
          setLocation(loc.coords);
          locationRef.current = loc.coords;
          try {
            let rev = await Location.reverseGeocodeAsync(loc.coords);
            if (rev[0]?.city) {
              setCurrentCity(rev[0].city);
            }
          } catch (e) {
            console.log("Geocode Error:", e);
          }

          // Standort in Profil aktualisieren – nur jede 10. Änderung (~100m)
          locationUpdateCounterRef.current += 1;
          if (locationUpdateCounterRef.current % 10 === 0) {
            await updateProfileLocation(loc.coords);
          }
        }
      );

      // Startposition sofort speichern
      if (sessionRef.current) {
        await updateProfileLocation(currentLoc.coords);
      }

      fetchAllMarkers(currentLoc.coords);
    } catch (e) { console.log(e); } finally { setIsLoading(false); }
  };

  const calculateDistance = (lat1, lon1, lat2, lon2) => {
    const R = 6371e3; // Earth's radius in meters
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c; // Distance in meters
  };

  const checkNearbyReports = async () => {
    const currentLocation = locationRef.current || location;
    if (!currentLocation) return;
    if (notificationStatusRef.current !== 'granted') {
      console.log('Push-Check uebersprungen: Notification-Berechtigung nicht erteilt.');
      return;
    }

    try {
      let query = supabase.from('reports').select('*').order('created_at', { ascending: false }).limit(20);

      if (lastMarkerSyncTimeRef.current) {
        query = query.gt('created_at', lastMarkerSyncTimeRef.current);
      }

      const { data: newReports, error } = await query;
      if (error) {
        console.log('Fehler beim Abfragen neuer Reports:', error);
        return;
      }

      if (newReports && newReports.length > 0) {
        for (const report of newReports) {
          await processReportForNotification(report);
        }
      }
    } catch (e) {
      console.log('Fehler bei Benachrichtigungsprüfung:', e);
    }
  };

  const processReportForNotification = async (report) => {
    const currentLocation = locationRef.current || location;
    if (!currentLocation || !report?.id) return;
    if (notificationStatusRef.current !== 'granted') return;
    if (notifiedReportIds.current.has(report.id)) return;
    if (isReportExpired(report)) return;

    const normalizedType = getNormalizedReportType(report.size);
    if (normalizedType === 'BIN_BAGS') return;

    const lat = parseFloat(report.latitude);
    const lng = parseFloat(report.longitude);
    if (isNaN(lat) || isNaN(lng)) return;

    const distance = calculateDistance(
      currentLocation.latitude,
      currentLocation.longitude,
      lat,
      lng
    );

    const isNearbyPoop = normalizedType === 'POOP' && distance < 500;
    const isPoisonAlert = normalizedType === 'POISON';
    if (!isNearbyPoop && !isPoisonAlert) return;

    notifiedReportIds.current.add(report.id);
    const typeMeta = getReportTypeMeta(report.size);
    const distanceText = distance < 100 ? 'ganz nah' : `${Math.round(distance / 10) * 10}m`;

    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: isPoisonAlert ? 'Giftköder Warnung!' : 'Haufen in der Nähe!',
          body: isPoisonAlert
            ? `${typeMeta.icon} Giftköder gemeldet in ${report.city}${distance < 500 ? ` (${distanceText} entfernt)` : ''}`
            : `${typeMeta.icon} ${distanceText} entfernt in ${report.city}`,
          sound: 'default',
          ...(Platform.OS === 'android' ? { channelId: 'poop-alerts' } : {}),
        },
        trigger: { seconds: 1 },
      });
    } catch (notificationError) {
      console.log('Fehler beim Planen der Benachrichtigung:', notificationError);
    }
  };

  const fetchAllMarkers = async (passedLocation) => {
    const { data } = await supabase.from('reports').select('*');
    if (data) {
      const nowMs = Date.now();
      const visibleReports = data.filter((item) => !isReportExpired(item, nowMs));

      setMarkers(visibleReports);
      const latestCreatedAt = data
        .map(item => item.created_at)
        .filter(Boolean)
        .sort()
        .reverse()[0];
      const syncMarkerTime = latestCreatedAt || new Date().toISOString();
      setLastMarkerSyncTime(syncMarkerTime);
      lastMarkerSyncTimeRef.current = syncMarkerTime;
      visibleReports.forEach(item => {
        if (item?.id) notifiedReportIds.current.add(item.id);
      });
      const counts = visibleReports.reduce((acc, item) => {
        if (getNormalizedReportType(item.size) !== 'POOP') return acc;
        if (item.city && item.city !== "Ortung...") {
          acc[item.city] = (acc[item.city] || 0) + 1; 
        }
        return acc; 
      }, {});
      const sorted = Object.keys(counts)
        .map(city => ({ name: city, count: counts[city] }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20);
      setCityStats(sorted);

      const effectiveLocation = passedLocation || locationRef.current || location;
      if (!startupNearbyInfoShown.current && effectiveLocation) {
        const nearbyPoop = [];
        const nearbyPoison = [];

        visibleReports.forEach((report) => {
          const normalizedType = getNormalizedReportType(report.size);
          if (normalizedType === 'BIN_BAGS') return;

          const lat = parseFloat(report.latitude);
          const lng = parseFloat(report.longitude);
          if (isNaN(lat) || isNaN(lng)) return;

          const distance = calculateDistance(effectiveLocation.latitude, effectiveLocation.longitude, lat, lng);
          if (distance > 500) return;

          if (normalizedType === 'POISON') nearbyPoison.push(report);
          if (normalizedType === 'POOP') nearbyPoop.push(report);
        });

        if (nearbyPoop.length > 0 || nearbyPoison.length > 0) {
          startupNearbyInfoShown.current = true;

          const parts = [];
          if (nearbyPoop.length > 0) parts.push(`${nearbyPoop.length} Haufen`);
          if (nearbyPoison.length > 0) parts.push(`${nearbyPoison.length} Giftköder`);

          const alertBody = nearbyPoop.length > 0
            ? `Pass auf deine Snicker auf. In 500m Naehe gefunden: ${parts.join(', ')}`
            : `Achtung: ${parts.join(', ')}`;

          Alert.alert('Achtung', alertBody);

          try {
            await Notifications.scheduleNotificationAsync({
              content: {
                title: 'Umgebungscheck beim Start',
                body: alertBody,
                sound: 'default',
                ...(Platform.OS === 'android' ? { channelId: 'poop-alerts' } : {}),
              },
              trigger: { seconds: 1 },
            });
          } catch (startupNotificationError) {
            console.log('Fehler beim Start-Umgebungscheck:', startupNotificationError);
          }
        }
      }
    }
  };

  const handleAuth = async (type) => {
    if (!email || !password) return;
    setIsLoading(true);
    const { error } = type === 'login' 
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password });
    setIsLoading(false);
    if (error) Alert.alert("Fehler", error.message);
    else { setShowAuth(false); setEmail(''); setPassword(''); }
  };

  const saveName = async () => {
    if (!session || !editNameInput.trim()) return;
    setIsLoading(true);
    const { error } = await supabase.auth.updateUser({ data: { display_name: editNameInput.trim() } });
    setIsLoading(false);
    if (!error) { setDisplayName(editNameInput.trim()); setIsEditingName(false); }
  };

  const createProfileRowIfMissing = async (sess) => {
    if (!sess?.user?.id) return;
    const profileRow = {
      id: sess.user.id,
      points: 0,
      total_reports: 0,
      clean_count: 0,
      publish_in_list: false,
      nickname: '',
    };

    const { error } = await supabase.from('profiles').insert([profileRow]);
    if (error) {
      const message = String(error.message || '');
      if (message.toLowerCase().includes('duplicate') || message.toLowerCase().includes('unique')) {
        return;
      }

      console.log('Profil-Erstellung mit optionalen Feldern fehlgeschlagen:', error.message);
      const fallbackRow = { id: sess.user.id, points: 0, total_reports: 0, clean_count: 0 };
      const { error: fallbackError } = await supabase.from('profiles').insert([fallbackRow]);
      if (fallbackError && !String(fallbackError.message || '').toLowerCase().includes('duplicate')) {
        console.log('Fallback Profilerstellung fehlgeschlagen:', fallbackError.message);
      }
    }
  };

  const loadLeaderboard = async () => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .order('points', { ascending: false })
        .limit(100);

      if (error) {
        console.log('Fehler beim Laden der Bestenliste:', error.message);
        return;
      }

      const leaderboardItems = (data || [])
        .filter((item) => item.publish_in_list === true)
        .sort((a, b) => (b.points || 0) - (a.points || 0) || (b.total_reports || 0) - (a.total_reports || 0))
        .slice(0, 20)
        .map((item, index) => ({
          id: item.id,
          rank: index + 1,
          nickname: item.nickname || item.display_name || `User ${index + 1}`,
          points: item.points || 0,
          totalReports: item.total_reports || 0,
        }));

      setLeaderboard(leaderboardItems);
    } catch (error) {
      console.log('Leaderboard laden fehlgeschlagen:', error);
    }
  };

  const saveProfileSettings = async () => {
    if (!session) return;
    setIsLoading(true);
    const trimmedNickname = nicknameInput.trim();
    const updatePayload = {
      nickname: trimmedNickname,
      publish_in_list: publishInList,
    };

    const { error } = await supabase.from('profiles').update(updatePayload).eq('id', session.user.id);
    setIsLoading(false);

    if (error) {
      console.log('Fehler beim Speichern der Profil-Einstellungen:', error.message);
      Alert.alert('Fehler', 'Profil-Einstellungen konnten nicht gespeichert werden.');
      return;
    }

    setNickname(trimmedNickname);
    setNicknameInput(trimmedNickname);
    setIsEditingNickname(false);
    loadLeaderboard();
  };

  const jumpToCity = (cityName) => {
    if (!cityName) return;
    const normalizedCityName = cityName.trim().toLowerCase();
    let cityMarker = markers.find(m => m.city?.trim().toLowerCase() === normalizedCityName);

    if (!cityMarker) {
      cityMarker = markers.find(m => m.city?.trim().toLowerCase().includes(normalizedCityName));
    }

    if (cityMarker) {
      const region = {
        latitude: parseFloat(cityMarker.latitude),
        longitude: parseFloat(cityMarker.longitude),
        latitudeDelta: 0.01,
        longitudeDelta: 0.01,
      };

      setActiveTab('Radar');
      pendingRegionRef.current = region;

      if (mapRef.current) {
        mapRef.current.animateToRegion(region, 1000);
        pendingRegionRef.current = null;
      }
    }
  };

  const reportPoop = async () => {
    if (!session) { Alert.alert("Stop!", "Bitte erst anmelden!"); return; }
    if (!location || currentCity === "Ortung...") {
      Alert.alert("Warte...", "Dein Standort wird noch präzisiert.");
      return;
    }

    await playReportFeedback();
    
    const tempMarker = {
      id: 'temp-' + Date.now(),
      latitude: location.latitude,
      longitude: location.longitude,
      size: selectedSize,
      city: currentCity,
      created_at: new Date().toISOString()
    };
    setMarkers(prevMarkers => [...prevMarkers, tempMarker]);

    const { error: reportError } = await supabase.from('reports').insert([{ 
      latitude: location.latitude,  // volle Namen nutzen!
      longitude: location.longitude, 
      size: selectedSize, 
      city: currentCity
    }]);

    if (!reportError) {
      const normalizedType = getNormalizedReportType(selectedSize);
      const isPoopReport = normalizedType === 'POOP';
      const reportPoints = isPoopReport ? 10 : 0;

      if (isPoopReport) {
        supabase.from('profiles').update({ 
          points: stats.points + reportPoints, 
          total_reports: stats.total + 1 
        }).eq('id', session.user.id).then(() => {
          updateProfileData(session);
        });
      } else {
        updateProfileData(session);
      }

      const typeMeta = getReportTypeMeta(selectedSize);
      Alert.alert("Erfolg", `${typeMeta.label} wurde gemeldet!${isPoopReport ? ` +${reportPoints} XP` : ''}`);
    } else {
      setMarkers(prevMarkers => prevMarkers.filter(m => m.id !== tempMarker.id));
      console.log(reportError);
    }
  };

  const deletePoop = async () => {
    if (!session || !selectedPoop) return;
    
    const { error: deleteError } = await supabase
      .from('reports')
      .delete()
      .eq('id', selectedPoop.id);

    if (!deleteError) {
        const rewardPoints = 25;

        await supabase
          .from('profiles')
          .update({ 
            points: stats.points + rewardPoints, 
            clean_count: stats.clean + 1 
          })
          .eq('id', session.user.id);
        
        setSelectedPoop(null);
        if (reportVibrationEnabled) {
          Vibration.vibrate(100);
        }
        await updateProfileData(session);
        Alert.alert("Sauber!", `Du hast ${rewardPoints} XP verdient! 🧹`);
    }
  };

  const openLegal = (title, text) => { setLegalContent({ title, text }); setLegalVisible(true); };

  if (isLoading) return <View style={styles.splash}><ActivityIndicator size="large" color="#8B4513" /><Text style={{marginTop: 15, color: '#8B4513', fontWeight: 'bold'}}>Radar lädt...</Text></View>;

  return (
    <View style={styles.container}>
      <View style={[styles.header, styles.shadow]}>
        <View><Text style={styles.xpTitle}>{session ? "PROFI" : "GAST"}</Text><Text style={styles.xpValue}>{stats.points} XP | {currentCity}</Text></View>
      </View>

      {activeTab === 'Radar' && (
        <View style={{ flex: 1 }}>
          <View style={[styles.adContainer, styles.shadow]}>
            <BannerAd
              size={BannerAdSize.ANCHORED_ADAPTIVE_BANNER}
              unitId={Platform.OS === 'android'
                ? 'ca-app-pub-2590841526378095/9563401535'
                : 'ca-app-pub-3940256099942544/2934735716'}
              requestOptions={{
                requestNonPersonalizedAdsOnly: false,
              }}
              onAdFailedToLoad={(error) => console.log('AdMob Fehler:', error)}
            />
          </View>

          <View style={{ flex: 1 }}>
            <MapView 
              ref={mapRef} 
              provider={PROVIDER_GOOGLE}
              loadingEnabled
              loadingIndicatorColor="#8B4513"
              mapType="standard"
              onMapReady={() => {
                if (pendingRegionRef.current && mapRef.current) {
                  mapRef.current.animateToRegion(pendingRegionRef.current, 1000);
                  pendingRegionRef.current = null;
                }
              }}
              style={styles.map} 
              showsUserLocation 
              followsUserLocation={true} 
              initialRegion={location ? { 
                latitude: location.latitude, 
                longitude: location.longitude, 
                latitudeDelta: 0.005, 
                longitudeDelta: 0.005 
              } : {
                latitude: 49.293, 
                longitude: 8.684,
                latitudeDelta: 0.05,
                longitudeDelta: 0.05
              }}
            > 
            {markers.map((marker, index) => {
              const markerKey = marker.id ? marker.id.toString() : `temp-${index}`;
              const lat = Number(marker.latitude);
              const lng = Number(marker.longitude);

              // Sicherheitscheck bleibt, damit die App nicht crasht
              if (!lat || !lng || isNaN(lat) || isNaN(lng)) return null;

              const markerMeta = getReportTypeMeta(marker.size);
              const markerSize = markerMeta.markerSize;
              const markerContainerSize = markerSize + 8;

              return (
                <Marker 
                  key={markerKey} 
                  coordinate={{ latitude: lat, longitude: lng }}
                  onPress={() => setSelectedPoop(marker)}
                  anchor={{ x: 0.5, y: 0.5 }}
                >
                  <View style={{ width: markerContainerSize, height: markerContainerSize, justifyContent: 'center', alignItems: 'center' }}>
                    <Text style={{ fontSize: markerSize, lineHeight: markerSize, textAlign: 'center' }}>{markerMeta.icon}</Text>
                  </View>
                </Marker>
              );
            })}
          </MapView>
          </View>

          {selectedPoop ? (
            <View style={[styles.infoCard, styles.shadow]}>
              <Text style={styles.infoTitle}>{getReportTypeMeta(selectedPoop.size).icon} Fund in {selectedPoop.city}</Text>
              <Text style={{color: '#666', marginBottom: 15, fontWeight: 'bold'}}>
                Typ: {getReportTypeMeta(selectedPoop.size).label}
              </Text>
              <TouchableOpacity style={styles.deleteBtn} onPress={deletePoop}>
                <Text style={{color: 'white', fontWeight: 'bold', fontSize: 16}}>ICH HAB'S WEGGERÄUMT ✅</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setSelectedPoop(null)} style={{marginTop: 10}}>
                <Text style={{textAlign: 'center', color: '#999', fontWeight: 'bold'}}>Schließen</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={[styles.overlay, styles.shadow]}>
              <Text style={styles.overlayLabel}>MELDETYP WÄHLEN</Text>
            <View style={styles.sizeRow}>
                {REPORT_TYPE_OPTIONS.map(item => (
                  <View key={item.id} style={{alignItems: 'center'}}>
                    <TouchableOpacity 
                      onPress={() => setSelectedSize(item.id)} 
                      style={[
                        styles.sizeBtn,
                        { backgroundColor: selectedSize === item.id ? '#8B4513' : '#f0f0f0' }
                      ]}
                    >
                      <Text style={{
                        color: 'white', 
                        fontWeight: 'bold', 
                        fontSize: item.markerSize,
                        includeFontPadding: false,
                        textAlign: 'center'
                      }}>
                        {item.icon}
                      </Text>
                    </TouchableOpacity>
                    <Text style={{marginTop: 8, fontWeight: 'bold', color: '#333', fontSize: 12}}>{item.shortLabel}</Text>
                  </View>
                ))}
              </View>

              <TouchableOpacity style={styles.mainReportBtn} onPress={reportPoop}>
                <Text style={styles.mainReportBtnText}>MELDUNG ABSENDEN</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}

      {activeTab === 'Score' && (
        <View style={styles.scoreContainer}>
          <Text style={styles.scoreTitle}>🏆 City Ranking</Text>
          <Text style={styles.scoreSubTitle}>Top 20 Städte</Text>
          <FlatList 
            data={cityStats} 
            keyExtractor={(item) => item.name} 
            renderItem={({item, index}) => (
              <TouchableOpacity 
                style={[styles.scoreItem, styles.shadow]} 
                onPress={() => jumpToCity(item.name)}
              >
                <Text style={styles.scoreRank}>#{index+1}</Text>
                <Text style={{flex: 1, fontSize: 16, fontWeight: '600'}}>{item.name}</Text>
                <Text style={{fontWeight: 'bold', fontSize: 16, color: '#8B4513'}}>{item.count} 💩</Text>
              </TouchableOpacity>
          )} />
        </View>
      )}

      {activeTab === 'Top' && (
        <View style={styles.scoreContainer}>
          <Text style={styles.scoreTitle}>🥇 Top 20 Melder</Text>
          <Text style={styles.scoreSubTitle}>Nur Profile mit freigegebenen Nicknames</Text>
          <FlatList
            data={leaderboard}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <View style={[styles.scoreItem, styles.shadow]}>
                <Text style={styles.scoreRank}>#{item.rank}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 16, fontWeight: '600' }}>{item.nickname}</Text>
                  <Text style={{ color: '#666', marginTop: 4 }}>{item.totalReports} Meldungen • {item.points} XP</Text>
                </View>
              </View>
            )}
            ListEmptyComponent={() => (
              <View style={[styles.scoreItem, styles.shadow, { justifyContent: 'center' }]}>
                <Text style={{ fontSize: 16, color: '#666', textAlign: 'center' }}>Noch keine freigegebenen Melder in der Bestenliste.</Text>
              </View>
            )}
          />
        </View>
      )}

      {activeTab === 'Profil' && (
        <ScrollView style={styles.profileScroll} showsVerticalScrollIndicator={false}>
          <View style={styles.profileHeaderCenter}>
            <View style={[styles.avatarLarge, styles.shadow]}>
              <Text style={styles.avatarTextLarge}>{displayName.charAt(0).toUpperCase()}</Text>
            </View>

            {isEditingName ? (
              <View style={{flexDirection: 'row', alignItems: 'center', marginTop: 15}}>
                <TextInput style={styles.nameEditInput} value={editNameInput} onChangeText={setEditNameInput} autoFocus placeholder="Dein Name" />
                <TouchableOpacity onPress={saveName} style={styles.nameSaveBtn}><Text style={{color: 'white', fontWeight: 'bold'}}>OK</Text></TouchableOpacity>
              </View>
            ) : (
              <View style={{flexDirection: 'row', alignItems: 'center', marginTop: 15}}>
                <Text style={styles.profileNameMain}>{displayName}</Text>
                {session && (
                  <TouchableOpacity onPress={() => { setEditNameInput(displayName); setIsEditingName(true); }} style={{marginLeft: 10}}>
                    <Text style={{fontSize: 20}}>✏️</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
            <Text style={styles.profileEmailSub}>{session?.user?.email || "Melde dich an für mehr XP"}</Text>
          </View>

          {session && (
            <View style={[styles.notificationSection, styles.shadow, { marginBottom: 25 }]}> 
              <Text style={styles.notificationSectionTitle}>Profil für Bestenliste</Text>
              <TextInput
                style={styles.inputField}
                value={nicknameInput}
                onChangeText={setNicknameInput}
                placeholder="Dein Nickname"
                autoCapitalize="words"
              />
              <View style={styles.settingRow}>
                <View style={styles.settingCopy}>
                  <Text style={styles.settingTitle}>Veröffentlichung erlauben</Text>
                  <Text style={styles.settingHint}>Zeige deinen Nickname in der Top 20 Liste.</Text>
                </View>
                <Switch
                  value={publishInList}
                  onValueChange={setPublishInList}
                  trackColor={{ false: '#D8D8D8', true: '#CBA27A' }}
                  thumbColor={publishInList ? '#8B4513' : '#F4F4F4'}
                />
              </View>
              <TouchableOpacity style={[styles.mainReportBtn, { backgroundColor: '#8B4513', marginTop: 8 }]} onPress={saveProfileSettings}>
                <Text style={styles.mainReportBtnText}>Speichern</Text>
              </TouchableOpacity>
            </View>
          )}

          <View style={[styles.rankingCard, styles.shadow]}>
            <Text style={styles.rankLabel}>🏆 DEUTSCHLANDWEIT</Text>
            <Text style={styles.rankNumber}>#{stats.rank}</Text>
          </View>

          <View style={[styles.levelCard, styles.shadow]}>
             <View style={{flexDirection: 'row', alignItems: 'center'}}>
                <Text style={{fontSize: 35, marginRight: 15}}>👶</Text>
                <View>
                  <Text style={{fontSize: 11, color: '#999', fontWeight: 'bold'}}>LEVEL {stats.level}</Text>
                  <Text style={{fontSize: 18, fontWeight: 'bold', color: '#333'}}>{stats.levelName}</Text>
                </View>
             </View>
             <View style={styles.progressBar}>
                <View style={[styles.progressFill, {width: `${stats.points % 100}%`}]} />
             </View>
          </View>

          <View style={styles.statsGrid}>
            <View style={[styles.statBox, styles.shadow]}>
              <Text style={{fontSize: 20}}>⭐</Text>
              <Text style={styles.statValue}>{stats.points}</Text>
              <Text style={styles.statLabel}>PUNKTE</Text>
            </View>
            <View style={[styles.statBox, styles.shadow]}>
              <Text style={{fontSize: 20}}>💩</Text>
              <Text style={styles.statValue}>{stats.total}</Text>
              <Text style={styles.statLabel}>MELDUNGEN</Text>
            </View>
            <View style={[styles.statBox, styles.shadow]}>
              <Text style={{fontSize: 20}}>🧹</Text>
              <Text style={styles.statValue}>{stats.clean}</Text>
              <Text style={styles.statLabel}>CLEAN</Text>
            </View>
          </View>

          <View style={[styles.notificationSection, styles.shadow]}>
            <Text style={styles.notificationSectionTitle}>Benachrichtigungen</Text>
            <Text style={styles.notificationStatusText}>
              {notificationStatus === 'granted'
                ? 'Benachrichtigungen sind aktiviert.'
                : notificationStatus === 'denied'
                ? 'Benachrichtigungen sind deaktiviert.'
                : 'Benachrichtigungsstatus unklar.'}
            </Text>
            <Text style={styles.notificationStatusText}>Push-Token: {pushTokenStatus}</Text>
            {notificationStatus !== 'granted' && (
              <TouchableOpacity onPress={openNotificationSettings} style={styles.openSettingsBtn}>
                <Text style={styles.openSettingsBtnText}>Einstellungen öffnen</Text>
              </TouchableOpacity>
            )}
          </View>

          <View style={[styles.notificationSection, styles.shadow]}>
            <Text style={styles.notificationSectionTitle}>Feedback beim Melden</Text>

            <View style={styles.settingRow}>
              <View style={styles.settingCopy}>
                <Text style={styles.settingTitle}>Vibration</Text>
                <Text style={styles.settingHint}>Kurzes Vibrationssignal beim Haufen melden.</Text>
              </View>
              <Switch
                value={reportVibrationEnabled}
                onValueChange={async (value) => {
                  await saveReportFeedbackSetting(REPORT_VIBRATION_STORAGE_KEY, value, setReportVibrationEnabled);
                  if (value) {
                    await triggerReportVibrationFeedback();
                  }
                }}
                trackColor={{ false: '#D8D8D8', true: '#CBA27A' }}
                thumbColor={reportVibrationEnabled ? '#8B4513' : '#F4F4F4'}
              />
            </View>

            <View style={styles.settingRow}>
              <View style={styles.settingCopy}>
                <Text style={styles.settingTitle}>Signalton</Text>
                <Text style={styles.settingHint}>Kurzer Ton beim erfolgreichen Tippen auf Melden.</Text>
              </View>
              <Switch
                value={reportSoundEnabled}
                onValueChange={(value) => saveReportFeedbackSetting(REPORT_SOUND_STORAGE_KEY, value, setReportSoundEnabled)}
                trackColor={{ false: '#D8D8D8', true: '#CBA27A' }}
                thumbColor={reportSoundEnabled ? '#8B4513' : '#F4F4F4'}
              />
            </View>
          </View>

          <View style={[styles.badgeSection, styles.shadow]}>
            <Text style={styles.badgeSectionTitle}>BADGES & MELDETYPEN</Text>
            <View style={styles.badgeGrid}>
              {badgeDefinitions.map((badge) => {
                const activeAccent = badge.accent || '#E7C68A';
                const activeSoft = badge.soft || '#FFF4DF';

                return (
                  <View
                    key={badge.id}
                    style={[
                      styles.badgeCard,
                      badge.achieved
                        ? [styles.badgeCardActive, { borderColor: activeAccent }]
                        : styles.badgeCardInactive,
                    ]}
                  >
                    <View
                      style={[
                        styles.badgeIconWrap,
                        badge.achieved
                          ? [styles.badgeIconWrapActive, { backgroundColor: activeSoft }]
                          : styles.badgeIconWrapInactive,
                      ]}
                    >
                      <Text style={[styles.badgeIcon, badge.achieved ? styles.badgeIconActive : styles.badgeIconInactive]}>{badge.icon}</Text>
                    </View>
                    <Text
                      style={[
                        styles.badgeTitle,
                        badge.achieved ? [styles.badgeTitleActive, { color: activeAccent }] : styles.badgeTitleInactive,
                      ]}
                    >
                      {badge.title}
                    </Text>
                    <Text style={[styles.badgeSubtitle, badge.achieved ? styles.badgeSubtitleActive : styles.badgeSubtitleInactive]}>{badge.subtitle}</Text>
                  </View>
                );
              })}
            </View>
          </View>

          <View style={styles.footer}>
            <TouchableOpacity onPress={() => openLegal('Datenschutz & Impressum', datenschutzText)} style={{marginBottom: 10}}>
              <Text style={styles.footerLink}>Datenschutz & Impressum</Text>
            </TouchableOpacity>
            {session && (
              <TouchableOpacity onPress={deleteAccount} style={[styles.authMainTrigger, {backgroundColor: '#d9534f', marginBottom: 10}]}> 
                <Text style={styles.authMainTriggerText}>ACCOUNT LÖSCHEN</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity 
              onPress={() => session ? supabase.auth.signOut() : setShowAuth(true)} 
              style={[styles.authMainTrigger, {backgroundColor: session ? '#555' : '#8B4513'}]}
            >
              <Text style={styles.authMainTriggerText}>{session ? 'AUSLOGGEN' : 'LOGIN / REGISTRIEREN'}</Text>
            </TouchableOpacity>
            <Text style={styles.footerSignature}>edit by pifka07</Text>
          </View>
          <View style={{height: 100}} />
        </ScrollView>
      )}

      <View style={styles.navbar}>
        {['Radar', 'Score', 'Top', 'Profil'].map(t => (
          <TouchableOpacity key={t} onPress={() => setActiveTab(t)} style={styles.navItem}>
            <Text style={{fontSize: 22, opacity: activeTab === t ? 1 : 0.4}}>{t === 'Radar' ? '🗺️' : (t === 'Score' ? '🏆' : (t === 'Top' ? '🥇' : '👀'))}</Text>
            <Text style={[styles.navText, {color: activeTab === t ? '#8B4513' : '#999'}]}>{t}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Modal visible={showAuth} animationType="slide">
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.authFullContainer}>
          <View style={styles.authForm}>
            <Text style={styles.authHeroTitle}>Haufen-Jäger</Text>
            <TextInput style={styles.inputField} placeholder="E-Mail" value={email} onChangeText={setEmail} autoCapitalize="none" />
            <TextInput style={styles.inputField} placeholder="Passwort" value={password} onChangeText={setPassword} secureTextEntry />
            <TouchableOpacity style={styles.loginBtn} onPress={() => handleAuth('login')}>
              <Text style={styles.loginBtnText}>EINLOGGEN</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.signupBtn} onPress={() => handleAuth('signup')}>
              <Text style={styles.signupBtnText}>Konto erstellen</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowAuth(false)} style={styles.cancelAuth}>
              <Text style={{color: '#999', fontWeight: 'bold'}}>Abbrechen</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={legalVisible} transparent animationType="fade">
        <View style={{flex:1, backgroundColor:'rgba(0,0,0,0.5)', justifyContent:'flex-end'}}>
          <View style={{backgroundColor:'white', padding:20, borderRadius:20, maxHeight:'90%', margin:15}}>
            <Text style={{fontSize:20, fontWeight:'bold', marginBottom:15}}>{legalContent.title}</Text>
            <ScrollView style={{marginVertical:15, maxHeight:500}}>
              <Text style={{fontSize:14, lineHeight:22, color:'#333'}}>{legalContent.text}</Text>
            </ScrollView>
            <TouchableOpacity onPress={() => setLegalVisible(false)} style={{backgroundColor:'#8B4513', padding:12, borderRadius:12, marginTop:15}}>
              <Text style={{color:'white', fontWeight:'bold', textAlign:'center', fontSize:16}}>Schließen</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8F9FA' },
  shadow: { elevation: 5, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 4 },
  header: { paddingTop: 60, paddingHorizontal: 20, paddingBottom: 15, flexDirection: 'row', justifyContent: 'space-between', backgroundColor: 'white' },
  xpTitle: { fontSize: 10, color: '#999', fontWeight: 'bold' },
  xpValue: { fontSize: 18, fontWeight: 'bold', color: '#8B4513' },
  headerProfileBtn: { backgroundColor: '#FDF5E6', paddingHorizontal: 15, paddingVertical: 8, borderRadius: 12, borderWidth: 1, borderColor: '#DEB887' },
  headerProfileBtnText: { color: '#8B4513', fontWeight: 'bold', fontSize: 12 },
  adContainer: { backgroundColor: 'white', alignItems: 'center', justifyContent: 'center', paddingVertical: 6, borderTopWidth: 1, borderBottomWidth: 1, borderColor: '#EEE' },
  map: { flex: 1 },
  overlay: { position: 'absolute', bottom: 18, left: 20, right: 20, backgroundColor: 'white', borderRadius: 24, padding: 18 },
  overlayLabel: { textAlign: 'center', color: '#999', marginBottom: 12, fontSize: 11, fontWeight: 'bold', letterSpacing: 1 },
  sizeRow: { flexDirection: 'row', justifyContent: 'center', marginBottom: 18 },
  sizeBtn: { width: 58, height: 58, backgroundColor: '#f0f0f0', borderRadius: 24, justifyContent: 'center', alignItems: 'center', marginHorizontal: 10 },
  sizeBtnActive: { backgroundColor: '#8B4513' },
  mainReportBtn: { height: 54, backgroundColor: '#FF4136', borderRadius: 15, justifyContent: 'center', alignItems: 'center' },
  mainReportBtnText: { color: 'white', fontWeight: 'bold', fontSize: 16 },
  navbar: { flexDirection: 'row', height: 95, backgroundColor: 'white', borderTopWidth: 1, borderColor: '#EEE', paddingBottom: 30, paddingTop: 10 },
  navItem: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  navText: { fontSize: 11, fontWeight: 'bold', marginTop: 4 },
  profileScroll: { flex: 1, padding: 20 },
  profileHeaderCenter: { alignItems: 'center', marginBottom: 30 },
  avatarLarge: { width: 90, height: 90, borderRadius: 45, backgroundColor: '#FF6347', justifyContent: 'center', alignItems: 'center' },
  avatarTextLarge: { color: 'white', fontSize: 40, fontWeight: 'bold' },
  profileNameMain: { fontSize: 24, fontWeight: 'bold' },
  profileEmailSub: { color: '#999', marginTop: 5 },
  nameEditInput: { backgroundColor: '#EEE', borderRadius: 8, paddingHorizontal: 15, height: 40, width: 160, fontSize: 18, fontWeight: 'bold', textAlign: 'center' },
  nameSaveBtn: { backgroundColor: '#4CAF50', paddingVertical: 10, paddingHorizontal: 15, borderRadius: 8, marginLeft: 10 },
  rankingCard: { backgroundColor: '#FF7F50', borderRadius: 25, padding: 22, marginBottom: 20 },
  rankLabel: { color: 'white', fontSize: 11, fontWeight: 'bold' },
  rankNumber: { color: 'white', fontSize: 48, fontWeight: 'bold' },
  levelCard: { backgroundColor: 'white', borderRadius: 20, padding: 20, marginBottom: 25 },
  progressBar: { height: 10, backgroundColor: '#F0F0F0', borderRadius: 5, marginTop: 15, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: '#FF7F50' },
  statsGrid: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 30 },
  statBox: { backgroundColor: 'white', width: '31%', paddingVertical: 15, borderRadius: 18, alignItems: 'center' },
  statValue: { fontSize: 18, fontWeight: 'bold', marginTop: 5 },
  statLabel: { fontSize: 8, color: '#999', fontWeight: 'bold' },
  notificationSection: { backgroundColor: 'white', borderRadius: 22, padding: 18, marginBottom: 25, borderWidth: 1, borderColor: '#E8E8EA' },
  notificationSectionTitle: { fontSize: 14, fontWeight: 'bold', color: '#333', marginBottom: 8 },
  notificationStatusText: { fontSize: 14, color: '#555', lineHeight: 20, marginBottom: 10 },
  openSettingsBtn: { backgroundColor: '#8B4513', paddingVertical: 12, borderRadius: 15, alignItems: 'center', marginTop: 5 },
  openSettingsBtnText: { color: 'white', fontWeight: 'bold', fontSize: 14 },
  settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10 },
  settingCopy: { flex: 1, paddingRight: 14 },
  settingTitle: { fontSize: 14, fontWeight: 'bold', color: '#333', marginBottom: 4 },
  settingHint: { fontSize: 12, color: '#666', lineHeight: 18 },
  footer: { marginTop: 20, alignItems: 'center' },
  footerLink: { color: '#999', fontSize: 14 },
  footerSignature: { marginTop: 12, fontSize: 11, fontStyle: 'italic', color: '#9A8F84', letterSpacing: 0.6, opacity: 0.9 },
  authMainTrigger: { width: '100%', height: 60, borderRadius: 15, justifyContent: 'center', alignItems: 'center', marginTop: 10 },
  authMainTriggerText: { color: 'white', fontWeight: 'bold' },
  scoreContainer: { flex: 1, padding: 20, paddingTop: 40 },
  scoreTitle: { fontSize: 30, fontWeight: 'bold', color: '#8B4513' },
  scoreSubTitle: { color: '#999', marginBottom: 20 },
  scoreItem: { flexDirection: 'row', padding: 20, backgroundColor: 'white', borderRadius: 18, marginBottom: 12, alignItems: 'center' },
  scoreRank: { fontSize: 20, fontWeight: 'bold', color: '#FF7F50', width: 45 },
  infoCard: { position: 'absolute', bottom: 30, left: 20, right: 20, backgroundColor: 'white', padding: 25, borderRadius: 25 },
  infoTitle: { fontWeight: 'bold', fontSize: 20, marginBottom: 5 },
  deleteBtn: { backgroundColor: '#4CAF50', padding: 18, borderRadius: 15, marginTop: 10, alignItems: 'center' },
  splash: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#FDF5E6' },
  authFullContainer: { flex: 1, backgroundColor: 'white' },
  authForm: { flex: 1, padding: 30, justifyContent: 'center' },
  authHeroTitle: { fontSize: 36, fontWeight: 'bold', color: '#333', marginBottom: 10 },
  inputField: { height: 65, backgroundColor: '#F7F7F7', borderRadius: 15, paddingHorizontal: 20, marginBottom: 15, fontSize: 16, borderWidth: 1, borderColor: '#EEE' },
  badgeSection: { backgroundColor: 'white', borderRadius: 25, padding: 20, marginBottom: 25, borderWidth: 1, borderColor: '#E8E8EA' },
  badgeSectionTitle: { fontSize: 16, fontWeight: 'bold', marginBottom: 14, color: '#333', letterSpacing: 0.5, textTransform: 'uppercase' },
  badgeGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  badgeCard: { width: '47%', backgroundColor: 'white', borderRadius: 20, paddingVertical: 16, paddingHorizontal: 14, marginBottom: 14, alignItems: 'center', minHeight: 144, justifyContent: 'flex-start', borderWidth: 1, borderColor: '#EEE' },
  badgeCardActive: { backgroundColor: 'white', borderColor: '#E7C68A' },
  badgeCardInactive: { opacity: 0.8, borderColor: '#EEE', backgroundColor: '#FFFFFF' },
  badgeIconWrap: { width: 46, height: 46, borderRadius: 24, backgroundColor: '#F4F4F6', justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
  badgeIconWrapActive: { backgroundColor: '#FFF4DF' },
  badgeIconWrapInactive: { backgroundColor: '#F4F4F6' },
  badgeIcon: { fontSize: 24 },
  badgeIconActive: { opacity: 1 },
  badgeIconInactive: { opacity: 0.45 },
  badgeTitle: { fontSize: 13, fontWeight: '700', marginBottom: 4, color: '#333', textAlign: 'center' },
  badgeTitleActive: { color: '#2C2C2C' },
  badgeTitleInactive: { color: '#7A7A7A' },
  badgeSubtitle: { fontSize: 10, color: '#777', lineHeight: 14, textAlign: 'center' },
  badgeSubtitleActive: { color: '#5F5F5F' },
  badgeSubtitleInactive: { color: '#A0A0A0' },
  loginBtn: { height: 65, backgroundColor: '#8B4513', borderRadius: 15, justifyContent: 'center', alignItems: 'center', marginTop: 10 },
  loginBtnText: { color: 'white', fontSize: 18, fontWeight: 'bold' },
  signupBtn: { height: 65, backgroundColor: '#C97818', borderRadius: 15, justifyContent: 'center', alignItems: 'center', marginTop: 10 },
  signupBtnText: { color: 'white', fontSize: 18, fontWeight: 'bold' },
  cancelAuth: { marginTop: 40, alignItems: 'center' }
});

