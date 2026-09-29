
exports.getAdsConfig = async (req, res) => {


    try {

        return res.status(200).json({
            success: true,
            message: "Configuration fetched successfully.",
            data: {

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
                    message: "We are upgrading our services to serve you better. The app will be available again shortly. Thank you for your patience."
                },

                ads: {

                    appId: {
                        enabled: true,
                        unitId: "ca-app-pub-1736153103436707~8699226986"
                    },
                    banner: {
                        enabled: true,
                        unitId: "ca-app-pub-3413420770089708/9904784483"
                    },

                    interstitial: {
                        enabled: true,
                        unitId: "ca-app-pub-3413420770089708/4681751116",
                        afterClicks: 3,
                        afterDownloads: 1
                    },

                    rewarded: {
                        enabled: false,
                        unitId: ""
                    },

                    native: {
                        enabled: true,
                        unitId: "ca-app-pub-3413420770089708/8429424432"
                    },

                    appOpen: {
                        enabled: true,
                        unitId: "ca-app-pub-3413420770089708/5321174667"
                    }

                },
                support: {

                    email: "support@stackearn.com",

                    website: "https://stackearn.com"


                },
                settings: {

                    privacy: "https://shorts-downloader.vercel.app/privacy-policy",

                    terms: "https://shorts-downloader.vercel.app/privacy-policy",
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