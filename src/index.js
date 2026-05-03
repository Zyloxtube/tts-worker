import puppeteer from '@cloudflare/puppeteer';

const CHARACTER_URLS = {
  'spongebob': 'https://nicevoice.org/ai-voice-generator/spongebob-squarepants/',
  'patrick': 'https://nicevoice.org/ai-voice-generator/patrick-star/',
  'squidward': 'https://nicevoice.org/ai-voice-generator/squidward-tentacles/',
  'mrkrabs': 'https://nicevoice.org/ai-voice-generator/mr-krabs/'
};

const jobs = new Map();

function generateJobId() {
  return crypto.randomUUID();
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

    // Route: /generate-and-wait
    if (path === '/generate-and-wait' && method === 'GET') {
      const text = url.searchParams.get('text')?.trim();
      const characterParam = url.searchParams.get('character')?.toLowerCase().replace(/\s/g, '') || 'spongebob';

      if (!text) {
        return Response.json({
          success: false,
          error: 'No text provided. Please add ?text=your_text_here'
        }, { status: 400, headers: corsHeaders });
      }

      let character = characterParam;
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

        // Launch browser
        const browser = await puppeteer.launch(env.MYBROWSER);
        const page = await browser.newPage();
        
        const voiceUrl = CHARACTER_URLS[character];
        
        // Navigate to character page - same as Python version
        await page.goto(voiceUrl, { waitUntil: 'networkidle2' });
        await page.waitForTimeout(2000);
        
        // Type text in textarea - same as Python version
        const textarea = await page.$('textarea.textarea');
        if (textarea) {
          await textarea.click({ clickCount: 3 });
          await textarea.type(text);
        }
        
        // Click generate button - same as Python version using querySelector
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
        
        // Wait for audio URL - checking every 0.5 seconds, max 90 seconds
        let audioUrl = null;
        for (let i = 0; i < 180; i++) {
          await page.waitForTimeout(500);
          const audioElement = await page.$('audio[src*=".mp3"]');
          if (audioElement) {
            audioUrl = await page.evaluate(el => el.getAttribute('src'), audioElement);
            if (audioUrl) break;
          }
        }
        
        await browser.close();
        
        if (audioUrl) {
          jobs.set(jobId, {
            ...jobs.get(jobId),
            status: 'completed',
            audio_url: audioUrl,
            completed_at: new Date().toISOString()
          });
          
          return Response.json({
            success: true,
            audio_url: audioUrl,
            text: text,
            character: character
          }, { headers: corsHeaders });
        } else {
          throw new Error('Timeout: Audio generation took too long');
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

    // Route: /characters
    if (path === '/characters' && method === 'GET') {
      return Response.json({
        success: true,
        characters: Object.keys(CHARACTER_URLS),
        default: 'spongebob'
      }, { headers: corsHeaders });
    }

    // Route: /health
    if (path === '/health' || path === '/') {
      const activeJobs = Array.from(jobs.values()).filter(j => j.status === 'processing').length;
      return Response.json({
        status: 'healthy',
        active_jobs: activeJobs,
        total_jobs: jobs.size,
        platform: 'Cloudflare Workers + Puppeteer'
      }, { headers: corsHeaders });
    }

    // Route: /status
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
