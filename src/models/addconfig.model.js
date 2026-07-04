const mongoose = require("mongoose");

const adsConfigSchema = new mongoose.Schema({

    // =========================
    // APP INFORMATION
    // =========================

    appId: {
        type: String,
        required: true,
        index: true
    },

    appName: {
        type: String,
        required: true
    },

    packageName: {
        type: String,
        default: ""
    },

    platform: {
        type: String,
        enum: ["android", "ios"],
        required: true
    },

    environment: {
        type: String,
        enum: ["production", "test"],
        default: "production"
    },

    // =========================
    // APP STATUS
    // =========================

    isAppActive: {
        type: Boolean,
        default: true
    },

    isMaintenance: {
        type: Boolean,
        default: false
    },

    maintenanceTitle: {
        type: String,
        default: ""
    },

    maintenanceMessage: {
        type: String,
        default: ""
    },

    maintenanceImage: {
        type: String,
        default: ""
    },

    // =========================
    // VERSION
    // =========================

    latestVersion: {
        type: String,
        default: "1.0.0"
    },

    minimumVersion: {
        type: String,
        default: "1.0.0"
    },

    forceUpdate: {
        type: Boolean,
        default: false
    },

    playStoreUrl: {
        type: String,
        default: ""
    },

    // =========================
    // ADS
    // =========================

    isAdsEnabled: {
        type: Boolean,
        default: true
    },

    adProvider: {
        type: String,
        default: "admob"
    },

    adProviderPriority: [{
        type: String
    }],

    banner: {
        enabled: {
            type: Boolean,
            default: true
        },
        unitId: {
            type: String,
            default: ""
        },
        refreshTime: {
            type: Number,
            default: 60
        }
    },

    interstitial: {
        enabled: {
            type: Boolean,
            default: true
        },
        unitId: {
            type: String,
            default: ""
        },
        afterClicks: {
            type: Number,
            default: 3
        },
        afterDownloads: {
            type: Number,
            default: 1
        },
        cooldown: {
            type: Number,
            default: 45
        }
    },

    rewarded: {
        enabled: {
            type: Boolean,
            default: false
        },
        unitId: {
            type: String,
            default: ""
        },
        rewardCoins: {
            type: Number,
            default: 10
        }
    },

    native: {
        enabled: {
            type: Boolean,
            default: false
        },
        unitId: {
            type: String,
            default: ""
        }
    },

    appOpen: {
        enabled: {
            type: Boolean,
            default: false
        },
        unitId: {
            type: String,
            default: ""
        },
        cooldown: {
            type: Number,
            default: 60
        }
    },

    // =========================
    // FEATURE FLAGS
    // =========================

    features: {

        youtubeEnabled: {
            type: Boolean,
            default: false
        },

        instagramEnabled: {
            type: Boolean,
            default: true
        },

        facebookEnabled: {
            type: Boolean,
            default: true
        },

        tiktokEnabled: {
            type: Boolean,
            default: true
        },

        xEnabled: {
            type: Boolean,
            default: true
        },

        snapchatEnabled: {
            type: Boolean,
            default: true
        },

        pinterestEnabled: {
            type: Boolean,
            default: true
        },

        redditEnabled: {
            type: Boolean,
            default: true
        },

        linkedinEnabled: {
            type: Boolean,
            default: true
        }
    },

    // =========================
    // POPUP
    // =========================

    popup: {

        enabled: {
            type: Boolean,
            default: false
        },

        title: {
            type: String,
            default: ""
        },

        message: {
            type: String,
            default: ""
        },

        image: {
            type: String,
            default: ""
        },

        buttonText: {
            type: String,
            default: "OK"
        },

        buttonUrl: {
            type: String,
            default: ""
        }

    },

    // =========================
    // RATING
    // =========================

    rating: {

        enabled: {
            type: Boolean,
            default: true
        },

        afterDownloads: {
            type: Number,
            default: 5
        },

        afterLaunches: {
            type: Number,
            default: 10
        }

    },

    // =========================
    // SUPPORT
    // =========================

    support: {

        email: {
            type: String,
            default: ""
        },

        website: {
            type: String,
            default: ""
        }

    },

    // =========================
    // LINKS
    // =========================

    privacyPolicy: {
        type: String,
        default: ""
    },

    termsConditions: {
        type: String,
        default: ""
    },

    // =========================
    // DEBUG
    // =========================

    testMode: {
        type: Boolean,
        default: false
    },

    enableLogs: {
        type: Boolean,
        default: false
    },

    enableAnalytics: {
        type: Boolean,
        default: true
    },

    enableCrashlytics: {
        type: Boolean,
        default: true
    },

    // =========================
    // EXTRA
    // =========================

    extra: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    }

}, {
    timestamps: true
});

adsConfigSchema.index(
    {
        appId: 1,
        platform: 1
    },
    {
        unique: true
    }
);

module.exports = mongoose.model("AdsConfig", adsConfigSchema);