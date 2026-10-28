const { safeDownloaderSettings } = require("../services/downloaderSettings");
const { buildAppExtras } = require("../services/appConfigExtras");

exports.getAdsConfig = async (req, res) => {
  try {
    const extras = await buildAppExtras("shorts", req);

    // Preserve existing dynamic download limits and add new settings
    const downloadLimits = extras.downloadLimits
      ? {
          ...extras.downloadLimits,
          disableInterstitialWhileUnlocked: true,
          allowDownloadWhenNoFill: false,
        }
      : {
          disableInterstitialWhileUnlocked: true,
          allowDownloadWhenNoFill: false,
        };

    return res.status(200).json({
      success: true,
      message: "Configuration fetched successfully.",
      data: {
        // Downloader optimisation settings
        downloader: safeDownloaderSettings(),

        // Download limits and device quota
        downloadLimits,
        downloadQuota: extras.downloadQuota,

        appName: "Shorts Downloader",
        appId: "com.stackearn.shorts_downloader",
        platform: "android",

        isAdsEnabled: true,
        forceUpdate: false,
        latestVersion: "1.0.2",
        minimumVersion: "1.0.0",

        maintenance: {
          enabled: false,
          title: "App Under Maintenance",
          message:
            "We are upgrading our services to serve you better. " +
            "The app will be available again shortly. Thank you for your patience.",
        },

     
ads: {
  // Existing field — old app compatibility
  appId: {
    enabled: true,
    unitId: "ca-app-pub-985698659865~8659862565",
  },

  // Existing fields — preserve their structure
  banner: {
    enabled: true,
    unitId: "ca-app-pub-1736153103436707/2243780642",
  },

  interstitial: {
    enabled: true,
    unitId: "ca-app-pub-1736153103436707/9930698975",
    afterClicks: 3,
    afterDownloads: 1,
    cooldownSeconds: 90,
  },

  // Preserve the existing backend-managed reward settings
  rewarded: {
    ...(extras.rewarded || {}),
    enabled: extras.rewarded?.enabled ?? true,
    unitId:
      extras.rewarded?.unitId ||
      "ca-app-pub-1736153103436707/5285952355",
  },

  native: {
    enabled: true,
    unitId: "ca-app-pub-1736153103436707/1741569414",
    feedEvery: 5,
  },

  appOpen: {
    enabled: true,
    unitId: "ca-app-pub-1736153103436707/8617617309",
    minBackgroundSeconds: 30,
    minIntervalSeconds: 300,
  },

  // NEW: Network-specific configuration.
  // Old app versions can ignore these extra fields.
  levelPlay: {
    enabled: true,
    appKey: "2844cbed5",

    banner: {
      enabled: true,
      unitId: "pg9zz9jwnbf7duau",
    },

    interstitial: {
      enabled: true,
      unitId: "57h0jysc3pf45yoc",
      cooldownSeconds: 90,
    },

    rewarded: {
      enabled: true,
      unitId: "kotiv7tca6nqxsq3",
    },

    native: {
      enabled: true,
      unitId: "gyc0o6mwmncpt8fw",
      placementName: "Home_Screen",
      feedEvery: 5,
    },
  },

},

        support: {
          email: "support@stackearn.com",
          website: "https://stackearn.com",
        },

        settings: {
          privacy: "https://shorts-downloader.vercel.app/privacy-policy",
          terms: "https://shorts-downloader.vercel.app/privacy-policy",
          whatsappNumber: "+917850972904",
          website: "https://shorts.stackearn.com",
          playStoreLink:
            "https://play.google.com/store/apps/details?id=com.vydo_all_video_downloader",
        },
      },
    });
  } catch (error) {
    console.error("getAdsConfig error:", error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};
