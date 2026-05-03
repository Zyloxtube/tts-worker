import puppeteer from '@cloudflare/puppeteer';

const CHARACTER_URLS = {
  'spongebob': 'https://nicevoice.org/ai-voice-generator/spongebob-squarepants/',
  'patrick': 'https://nicevoice.org/ai-voice-generator/patrick-star/',
  'squidward': 'https://nicevoice.org/ai-voice-generator/squidward-tentacles/',
  'mrkrabs': 'https://nicevoice.org/ai-voice-generator/mr-krabs/'
};

const jobs = new Map();
let persistentBrowser = null;
let pendingRequests = [];
let isProcessing = false;

function generateJobId() {
  return crypto.randomUUID();
}

async function getBrowser(env) {
  if (!persistentBrowser) {
    persistentBrowser = await puppeteer.launch(env.MYBROWSER);
  }
  return persistentBrowser;
}

async function generateVoiceover(text, character, env) {
  const browser = await getBrowser(env);
  const page = await browser.newPage();
  
  try {
    const voiceUrl = CHARACTER_URLS[character];
    
    await page.goto(voiceUrl, { waitUntil: 'networkidle2' });
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const textarea = await page.$('textarea.textarea');
    if (textarea) {
      await textarea.click({ clickCount: 3 });
      await textarea.type(text);
    }
    
    const generateButton = await page.evaluateHandle(() => {
      const buttons = document.querySelectorAll('button.btn-primary');
      for (const btn of buttons) {
        if (btn.textContent && btn.textContent.includes('Generate Voiceover')) {
          return btn;
        }
      }
      return null;
    });
    
    if (generateButton) {
      await generateButton.click();
    }
    
    let audioUrl = null;
    for (let i = 0; i < 180; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const audioElement = await page.$('audio[src*=".mp3"]');
      if (audioElement) {
        audioUrl = await page.evaluate(el => el.getAttribute('src'), audioElement);
        if (audioUrl) break;
      }
    }
    
    return { success: true, audio_url: audioUrl, text, character };
    
  } catch (error) {
    return { success: false, error: error.message };
  } finally {
    await page.close();
  }
}

async function processQueue(env) {
  if (isProcessing) return;
  if (pendingRequests.length === 0) return;
  
  isProcessing = true;
  
  while (pendingRequests.length > 0) {
    const request = pendingRequests.shift();
    try {
      const result = await generateVoiceover(request.text, request.character, env);
      request.resolve(result);
    } catch (error) {
      request.reject(error);
    }
  }
  
  isProcessing = false;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (path === '/generate-and-wait' && method === 'GET') {
      const text = url.searchParams.get('text')?.trim();
      let character = url.searchParams.get('character')?.toLowerCase().replace(/\s/g, '') || 'spongebob';

      if (!text) {
        return Response.json({
          success: false,
          error: 'No text provided. Please add ?text=your_text_here'
        }, { status: 400, headers: corsHeaders });
      }

      if (!CHARACTER_URLS[character]) {
        character = 'spongebob';
      }

      const jobId = generateJobId();
      jobs.set(jobId, {
        status: 'pending',
        text: text,
        character: character,
        created_at: new Date().toISOString()
      });

      try {
        jobs.set(jobId, { ...jobs.get(jobId), status: 'processing' });

        // Add to queue and wait for result
        const result = await new Promise((resolve, reject) => {
          pendingRequests.push({
            text,
            character,
            resolve,
            reject
          });
          processQueue(env);
        });
        
        if (result.success) {
          jobs.set(jobId, {
            ...jobs.get(jobId),
            status: 'completed',
            audio_url: result.audio_url,
            completed_at: new Date().toISOString()
          });
          
          return Response.json({
            success: true,
            audio_url: result.audio_url,
            text: result.text,
            character: result.character
          }, { headers: corsHeaders });
        } else {
          throw new Error(result.error);
        }
        
      } catch (error) {
        jobs.set(jobId, {
          ...jobs.get(jobId),
          status: 'failed',
          error: error.message
        });
        
        return Response.json({
          success: false,
          error: error.message
        }, { status: 500, headers: corsHeaders });
      }
    }

    if (path === '/characters' && method === 'GET') {
      return Response.json({
        success: true,
        characters: Object.keys(CHARACTER_URLS),
        default: 'spongebob'
      }, { headers: corsHeaders });
    }

    if (path === '/health' || path === '/') {
      const activeJobs = Array.from(jobs.values()).filter(j => j.status === 'processing').length;
      return Response.json({
        status: 'healthy',
        active_jobs: activeJobs,
        total_jobs: jobs.size,
        queue_length: pendingRequests.length,
        browser_alive: persistentBrowser !== null,
        platform: 'Cloudflare Workers + Puppeteer (Persistent Browser)'
      }, { headers: corsHeaders });
    }

    if (path === '/status' && method === 'GET') {
      const jobId = url.searchParams.get('job_id');
      
      if (!jobId || !jobs.has(jobId)) {
        return Response.json({
          success: false,
          error: 'Invalid or missing job_id'
        }, { status: 404, headers: corsHeaders });
      }
      
      const job = jobs.get(jobId);
      
      if (job.status === 'completed') {
        return Response.json({
          success: true,
          status: 'completed',
          audio_url: job.audio_url,
          text: job.text,
          character: job.character,
          created_at: job.created_at,
          completed_at: job.completed_at
        }, { headers: corsHeaders });
      } else if (job.status === 'failed') {
        return Response.json({
          success: false,
          status: 'failed',
          error: job.error
        }, { status: 500, headers: corsHeaders });
      } else {
        return Response.json({
          success: true,
          status: job.status,
          message: 'Still processing... check back soon'
        }, { headers: corsHeaders });
      }
    }

    return Response.json({
      success: false,
      error: 'Endpoint not found'
    }, { status: 404, headers: corsHeaders });
  }
};
