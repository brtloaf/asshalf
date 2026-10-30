# asshalf

A one-cut puzzle game with live multiplayer, running on Cloudflare Workers.

- `public/index.html` is the whole game. Every mode works offline in the browser except Party.
- `src/worker.js` serves the game and runs a small game server for each room. Each 4-letter room code gets its own Durable Object, and players connect to it over a WebSocket.
- `wrangler.jsonc` is the Cloudflare configuration.

## Try it on your computer first

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm run dev
```

Open http://localhost:8787 in two browser windows. Go to Party, create a room in one window, and join it from the other with the code.

## Put it online with GitHub and Cloudflare

1. Create a new GitHub repository and push this folder to it:
   ```bash
   git init
   git add .
   git commit -m "asshalf"
   git branch -M main
   git remote add origin https://github.com/YOUR-NAME/asshalf.git
   git push -u origin main
   ```
2. In the Cloudflare dashboard, open **Workers & Pages**, choose **Create application**, then import your GitHub repository.
3. Keep the project name as **asshalf**. It has to match `"name"` in `wrangler.jsonc`, or the build fails. If you want a different name, change it in both places.
4. Leave the build command empty. The deploy command should be `npx wrangler deploy`, which is the default.
5. Select **Save and Deploy**. Your game will be live at `https://asshalf.YOUR-SUBDOMAIN.workers.dev`.

From then on, every push to `main` redeploys automatically.

To use your own domain, open the Worker in the dashboard and go to **Settings → Domains & Routes → Add → Custom domain**.

## Playing with friends

1. Open **Party**, type your name, and select **Create room**.
2. Select **Copy invite link** and send it to your friends. The link takes them straight into your room.
3. The host picks the rules and the number of rounds, then starts the game:
   - **Halves:** cut each shape 50/50.
   - **Hit the target %:** cut off a given percentage of each shape.
   - **Three pieces:** make two cuts to hit three target percentages.
4. Every round, everyone gets the same shape. You can see friends' blades as faint dashed lines while they aim. Results stay hidden until everyone has cut or the clock runs out (30 seconds, or 45 for three pieces). Then all the cuts are revealed together.

Rooms hold up to 8 players. If you close the tab and come back, you rejoin as the same player with your score kept. When the host leaves, the next player becomes host.

## Notes

- **Cost.** Durable Objects are on Cloudflare's free plan as long as they use SQLite storage, which this project does. Sockets use the hibernation API, so idle rooms aren't billed for time. The daily free limits are far beyond what a group of friends will use.
- **Scoring.** Scores are calculated in each player's browser and sent to the room. That's fine among friends, but a determined cheater could fake a score.
- **Saved data.** Stats, achievements, and the tree are stored in each player's own browser.
