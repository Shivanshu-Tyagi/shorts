exports.getVydoAdsConfig = async (req, res) => {
    try {

        return res.status(200).json({
            success: true,
            message: "Configuration fetched successfully.",
            data: {

                appName: "VYDO - All Video Downloader",

                appId: "com.stackearn.shorts_downloader",

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

                    banner: {
                        enabled: true,
                        unitId: "ca-app-pub-9076860828061415/9646722049"
                    },

                    interstitial: {
                        enabled: true,
                        unitId: "ca-app-pub-9076860828061415/5707477035",
                        afterClicks: 3,
                        afterDownloads: 1
                    },

                    rewarded: {
                        enabled: false,
                        unitId: ""
                    },

                    native: {
                        enabled: true,
                        unitId: "ca-app-pub-9076860828061415/8364329884"
                    },

                    appOpen: {
                        enabled: true,
                        unitId: "ca-app-pub-9076860828061415/1731472922"
                    }

                },
                support: {

                    email: "support@stackearn.com",

                    website: "https://stackearn.com"

                },
                   settings: {

                    privacy: "https://bydo-all-video-downloader.vercel.app/privacy-policy",

                    terms: "https://bydo-all-video-downloader.vercel.app/privacy-policy"

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