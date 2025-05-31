const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');
const config = require('../config/config');
const cheerio = require('cheerio');

class InstagramService {
    constructor() {
        this.options = {
            apiTimeout: config.API.TIMEOUT_MS,
            imageFetchTimeout: config.API.IMAGE_FETCH_TIMEOUT_MS,
            apiUrlBase: config.API.INSTAGRAM_API_URL_BASE
        };
    }

    async fetchProfileData(username) {
        logger.info(`Fetching profile data for @${username}...`);
        try {
            const apiData = await this._fetchFromAPI(username);
            let profileData = this._parseApiResponse(apiData, username);

            if (profileData.apiResponseJson && profileData.apiResponseJson.status === true && profileData.userProfilePic) {
                profileData.userProfilePicHash = await this._getImageHash(profileData.userProfilePic);
            }

            return { success: true, data: profileData, timestamp: new Date().toISOString() };
        } catch (error) {
            logger.error(`Error fetching profile data for @${username}: ${error.message}`);
            return { success: false, error: error.message, timestamp: new Date().toISOString() };
        }
    }

    async fetchStoryData(username) {
        const apiUrl = `https://content.mollygram.com/?url=${encodeURIComponent(username)}&method=allstories`;
        logger.info(`Fetching story data for @${username} from: ${apiUrl}`);
        try {
            const response = await axios.get(apiUrl, { timeout: 15000 });
            const data = response.data;
            
            if (data && data.status === 'ok' && data.html) {
                const mediaData = this._extractMediaUrl(data.html);
                if (mediaData.url) {
                    return { 
                        status: 'ok', 
                        mediaType: mediaData.type,
                        mediaUrl: mediaData.url 
                    };
                }
                return { status: 'error', msg: 'No media URL found in story HTML.' };
            } 
            
            if (data && data.status === 'error' && data.msg && data.msg.includes('no stories')) {
                return { status: 'no_stories', msg: data.msg };
            }
            
            return { status: 'error', msg: data && data.msg ? data.msg : 'Unknown error from story API.' };
        } catch (error) {
            logger.error(`Error fetching/parsing story for @${username}: ${error.message}`);
            return { status: 'error', msg: error.message };
        }
    }

    async _fetchFromAPI(username) {
        const apiUrl = `${this.options.apiUrlBase}?username=${encodeURIComponent(username)}`;
        logger.debug(`Calling Instagram API for @${username}: ${apiUrl}`);
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.options.apiTimeout);

            const response = await fetch(apiUrl, {
                method: "GET",
                headers: {
                    "Origin": "https://www.tucktools.com",
                    "Referer": "https://www.tucktools.com/",
                    "User-Agent": "Mozilla/5.0 (compatible; InstagramMonitorBot/1.0)",
                },
                signal: controller.signal,
            });
            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`API request failed for @${username} (status ${response.status})`);
            }
            return await response.json();
        } catch (error) {
            throw error;
        }
    }

    _parseApiResponse(apiData, targetUsername) {
        if (!apiData || apiData.status !== true) {
            return {
                username: targetUsername.toLowerCase(),
                scrapedUsername: targetUsername.toLowerCase(),
                userFullname: null, userDescription: null, userProfilePic: null, userProfilePicHash: null,
                isPrivate: null, followersCount: 0, followingCount: 0, postsCount: 0, isVerified: null,
                rawFollowers: '0', rawFollowing: '0', rawPosts: '0',
                apiResponseJson: apiData || { status: false, message: "No valid data from API" },
            };
        }

        return {
            username: targetUsername.toLowerCase(),
            scrapedUsername: (apiData.username || targetUsername).toLowerCase(),
            userFullname: apiData.user_fullname || null,
            userDescription: apiData.user_description || null,
            userProfilePic: apiData.user_profile_pic || null,
            userProfilePicHash: null,
            isPrivate: apiData.is_private === true,
            followersCount: parseInt(apiData.user_followers, 10) || 0,
            followingCount: parseInt(apiData.user_following, 10) || 0,
            postsCount: parseInt(apiData.total_posts, 10) || 0,
            isVerified: apiData.is_verified === true,
            rawFollowers: String(apiData.user_followers || '0'),
            rawFollowing: String(apiData.user_following || '0'),
            rawPosts: String(apiData.total_posts || '0'),
            apiResponseJson: apiData,
        };
    }

    async _getImageHash(url) {
        if (!url) return null;
        
        try {
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: this.options.imageFetchTimeout
            });
            
            if (response.status === 200 && response.data) {
                return crypto.createHash('md5').update(response.data).digest('hex');
            }
            return null;
        } catch (error) {
            logger.warn(`Error fetching/hashing image: ${error.message}`);
            return null;
        }
    }

    _extractMediaUrl(html) {
        try {
            const $ = cheerio.load(html);
            
            // Try video source first
            const videoSource = $('video > source[type="video/mp4"]').attr('src');
            if (videoSource) {
                return { type: 'video', url: videoSource };
            }

            // Try download link for video
            const downloadLink = $('a.btn.bg-gradient-success[href]').attr('href');
            if (downloadLink && downloadLink.endsWith('.mp4')) {
                return { type: 'video', url: downloadLink };
            }

            // Try generic MP4 links
            const genericVideoLink = $('a[href$=".mp4"], video > source[src$=".mp4"]').attr('href') || 
                                   $('video > source[src$=".mp4"]').attr('src');
            if (genericVideoLink) {
                return { type: 'video', url: genericVideoLink };
            }

            // Try image sources
            const imgSource = $('img.story-image').attr('src');
            if (imgSource) {
                return { type: 'photo', url: imgSource };
            }

            // Try generic image links
            const imageLink = $('a[href$=".jpg"], a[href$=".jpeg"], a[href$=".png"]').attr('href');
            if (imageLink) {
                return { type: 'photo', url: imageLink };
            }

            // If no media found
            return { type: null, url: null };
        } catch (error) {
            logger.error('Error parsing media URL from HTML:', error);
            return { type: null, url: null };
        }
    }

    async fetchAllPosts(username) {
        try {
            const apiUrl = `${config.API.MOLLYGRAM_URL || 'https://content.mollygram.com'}`;
            const response = await axios.get(apiUrl, {
                params: {
                    url: username,
                    method: 'allposts'
                },
                timeout: 10000
            });

            if (response.data && response.data.status === 'ok' && response.data.html) {
                // Parse the HTML response to extract posts
                const posts = this._parsePostsFromHtml(response.data.html);
                return {
                    status: 'ok',
                    posts: posts
                };
            }

            return {
                status: 'error',
                message: 'Failed to fetch posts'
            };
        } catch (error) {
            logger.error(`Error fetching posts for @${username}:`, error);
            return {
                status: 'error',
                message: error.message
            };
        }
    }

    _parsePostsFromHtml(html) {
        try {
            const posts = [];
            const $ = cheerio.load(html);
            
            // Find all post containers
            $('div').each((i, element) => {
                try {
                    const $element = $(element);
                    
                    // Look for post indicators
                    const hasLikes = $element.find('small').text().includes('K');
                    const hasMedia = $element.find('a:contains("Download HD")').length > 0;
                    
                    if (hasLikes && hasMedia) {
                        const mediaUrl = this._extractPostMediaUrl($element);
                        if (mediaUrl) {
                            const post = {
                                id: this._generatePostId(mediaUrl),
                                mediaUrl: mediaUrl,
                                mediaType: this._determinePostMediaType($element),
                                caption: this._extractPostCaption($element),
                                timestamp: this._extractPostTimestamp($element)
                            };
                            posts.push(post);
                        }
                    }
                } catch (error) {
                    logger.error('Error parsing individual post:', error);
                }
            });
            
            return posts;
        } catch (error) {
            logger.error('Error parsing posts from HTML:', error);
            return [];
        }
    }

    _extractPostMediaUrl($element) {
        const downloadLink = $element.find('a:contains("Download HD")').attr('href');
        if (downloadLink) {
            return downloadLink;
        }
        
        // Try video source
        const videoSource = $element.find('video > source').attr('src');
        if (videoSource) {
            return videoSource;
        }
        
        // Try image source
        const imgSource = $element.find('img').attr('src');
        if (imgSource) {
            return imgSource;
        }
        
        return null;
    }

    _determinePostMediaType($element) {
        if ($element.find('video').length > 0 || 
            $element.find('source[type="video/mp4"]').length > 0 ||
            $element.find('a[href$=".mp4"]').length > 0) {
            return 'video';
        }
        return 'photo';
    }

    _extractPostCaption($element) {
        const captionElement = $element.find('p');
        return captionElement.text().trim() || null;
    }

    _extractPostTimestamp($element) {
        const timeElement = $element.find('small:contains("ago")');
        if (timeElement.length) {
            const timeText = timeElement.text().trim();
            return this._parseRelativeTime(timeText);
        }
        return new Date();
    }

    _generatePostId(mediaUrl) {
        return crypto.createHash('md5').update(mediaUrl).digest('hex');
    }

    _parseRelativeTime(timeText) {
        const now = new Date();
        const match = timeText.match(/(\d+)\s*(day|week|month)s?\s*ago/i);
        
        if (match) {
            const [_, amount, unit] = match;
            const value = parseInt(amount);
            
            switch(unit.toLowerCase()) {
                case 'day':
                    return new Date(now - value * 24 * 60 * 60 * 1000);
                case 'week':
                    return new Date(now - value * 7 * 24 * 60 * 60 * 1000);
                case 'month':
                    return new Date(now - value * 30 * 24 * 60 * 60 * 1000);
                default:
                    return now;
            }
        }
        
        return now;
    }
}

module.exports = InstagramService;
