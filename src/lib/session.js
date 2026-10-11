//redis connection
import { redis } from './redis.js'
const TTL = 86400 //store an days worth of time 
// used to get the session id of each chat and return the data in an array form if it exists
export async function getSession(chatId) {
  try {
    const data = await redis.get(`session:${chatId}`)
    console.log('Raw data from Redis:', data, 'Type:', typeof data)
    if (typeof data === 'object' && data !== null) {
      return data
    }
    return data ? JSON.parse(data) : []
  } catch (error) {
    console.error(`Error message for parsing session ${chatId}`, error)
    return []
  }
}

//use the acquired chat id to save the stringified message and then destruct after an hour of inactivity
export async function saveSession(chatId, messages) {
  await redis.set(`session:${chatId}`, JSON.stringify(messages), { ex: TTL })
}

//erases the stored data
export async function clearSession(chatId) {
  await redis.del(`session:${chatId}`)
}

// gets the chat mode this makes the mode change to chat by default
export async function getMode(chatId){
  const mode = await redis.get(`mode:${chatId}`)
  return mode || `chat`
}

export async function setPendingChart(chatId, data){
  await redis.set(`chart:${chatId}`, JSON.stringify(data), {ex: TTL})
}

export async function getPendingChart(chatId){
  try{
    const data = await redis.get(`chart:${chatId}`)
    if(typeof data === 'object' && data != null){
      return data
    }
    return data ? JSON.parse(data) : null
  }catch(error){
    console.error(`Error parsing pending chart for ${chatId}`, error)
    return null
  }
}

export async function setMode(chatId, mode){
  await redis.set(`mode:${chatId}`, mode)
}

export async function setChartState(chatId, state) {
  await redis.set(`chartState:${chatId}`, JSON.stringify(state), { ex: 3600 }); // 1hr expiry
}

export async function getChartState(chatId) {
  try {
    const data = await redis.get(`chartState:${chatId}`)
    if (typeof data === 'object' && data !== null) {
      return data
    }
    return data ? JSON.parse(data) : null
  } catch (error) {
    console.error(`Error parsing chartState for ${chatId}`, error)
    return null
  }
}

export async function setAwaitingCustomAmount(chatId, waiting){
  if (waiting) await redis.set(`awaiting_custom:${chatId}`, '1', {ex: 300})
  else await redis.del(`awaiting_custom:${chatId}`)
}

export async function getAwaitingCustomAmount(chatId){
  const val = await redis.get(`awaiting_custom:${chatId}`)
  return val === '1' || val === 1
}

export async function setAccountMode(userId, mode) {
  if (mode === 'real') await redis.set(`account:${userId}`, 'real', { ex: 3600 })
  else await redis.del(`account:${userId}`)
}

export async function getAccountMode(userId) {
  const val = await redis.get(`account:${userId}`)
  return val === 'real' ? 'real' : 'paper'
}

