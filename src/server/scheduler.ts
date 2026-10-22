export interface TimerClock {
  setTimeout(callback:()=>void,delay:number):unknown;
  clearTimeout(handle:unknown):void;
}
const realClock: TimerClock={
  setTimeout:(callback,delay)=>setTimeout(callback,delay),
  clearTimeout:handle=>clearTimeout(handle as ReturnType<typeof setTimeout>)
};
interface Task { handle:unknown; running:boolean; run:()=>Promise<void> }
/** Owns exactly one sleeping or computing turn per session. Settings only retime
 * sleeping tasks; a running worker keeps ownership until its result is committed. */
export class TurnScheduler {
  private tasks=new Map<string,Task>();
  private closed=false;
  constructor(private idle:(session:string)=>void,private clock:TimerClock=realClock){}
  private arm(session:string,task:Task,delay:number){
    task.handle=this.clock.setTimeout(()=>{
      if(this.closed||this.tasks.get(session)!==task)return;
      task.running=true;
      void task.run().finally(()=>{
        if(this.tasks.get(session)===task){this.tasks.delete(session);if(!this.closed)this.idle(session);}
      });
    },delay);
  }
  schedule(session:string,delay:number,run:()=>Promise<void>){
    if(this.closed||this.tasks.has(session))return;
    const task:Task={handle:undefined,running:false,run};
    this.tasks.set(session,task);this.arm(session,task,delay);
  }
  retime(session:string,delay:number){
    const task=this.tasks.get(session);if(!task||task.running)return;
    this.clock.clearTimeout(task.handle);this.arm(session,task,delay);
  }
  cancel(session:string){
    const task=this.tasks.get(session);if(task)this.clock.clearTimeout(task.handle);
    this.tasks.delete(session);
  }
  close(){this.closed=true;for(const session of this.tasks.keys())this.cancel(session);}
}
