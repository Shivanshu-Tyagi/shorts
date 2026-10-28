const { safeDownloaderSettings } = require("../services/downloaderSettings");
const { buildAppExtras } = require("../services/appConfigExtras");
exports.getVydoAdsConfig = async (req, res) => {
    try {

        const extras = await buildAppExtras("vydo", req);

        return res.status(200).json({
            success: true,
            message: "Configuration fetched successfully.",
            data: {

                // Additive: downloader optimisation settings (see docs/OPTIMIZATION.md)
                downloader: safeDownloaderSettings(),

                // Additive: dynamic download limits + (when ?deviceId= is sent) that device's quota state
                downloadLimits: extras.downloadLimits,
                downloadQuota: extras.downloadQuota,

                appName: "VYDO - All Video Downloader",

                appId: "com.vydo_all_video_downloader",

                platform: "android",

                isAdsEnabled: true,

                forceUpdate: false,

                latestVersion: "1.0.2",

                minimumVersion: "1.0.0",
                maintenance: {
                    enabled: false,
                    title: "App Under Maintenance",
                    message: "We are upgrading our services to serve you better. The app will be available again shortly. Thank you for your patience."
                },

                ads: {
                       appId: {
                        enabled: true,
                        unitId: "ca-app-pub-8555885558581851~7050683565"
                    },

                    banner: {
                        enabled: true,
                        unitId: "ca-app-pub-3413420770089708/9509288924"
                    },

                    interstitial: {
                        enabled: true,
                        unitId: "ca-app-pub-3413420770089708/8252047572",
                        afterClicks: 3,
                        afterDownloads: 1
                    },

                    rewarded: extras.rewarded,

                    native: {
                        enabled: true,
                        unitId: "ca-app-pub-3413420770089708/6689156648"
                    },

                    appOpen: {
                        enabled: true,
                        unitId: "ca-app-pub-3413420770089708/6657718707"
                    }

                },
                support: {
                    email: "support@stackearn.com",
                    website: "https://stackearn.com"

                },
                settings: {

                    privacy: "https://bydo-all-video-downloader.vercel.app/privacy-policy",

                    terms: "https://bydo-all-video-downloader.vercel.app/privacy-policy",
                    whatsappNumber: "+917850972904",
                    website: "https://shorts.stackearn.com",
                    playStoreLink: "https://play.google.com/store/apps/details?id=com.vydo_all_video_downloader",



                }

            }

        });

    } catch (error) {

        return res.status(500).json({
            success: false,
            message: error.message
        });

    }

};