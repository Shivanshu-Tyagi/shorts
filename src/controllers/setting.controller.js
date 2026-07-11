
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

                    banner: {
                        enabled: true,
                        unitId: "ca-app-pub-8555885558581851/8272002561"
                    },

                    interstitial: {
                        enabled: true,
                        unitId: "ca-app-pub-8555885558581851/7798606683",
                        afterClicks: 3,
                        afterDownloads: 1
                    },

                    rewarded: {
                        enabled: false,
                        unitId: ""
                    },

                    native: {
                        enabled: true,
                        unitId: "ca-app-pub-8555885558581851/6701147431"
                    },

                    appOpen: {
                        enabled: true,
                        unitId: "ca-app-pub-8555885558581851/6055078936"
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
                    website:"https://shorts.stackearn.com"

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