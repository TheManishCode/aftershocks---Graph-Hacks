from shop.db import connect


def load_user(uid):
    store = connect("sqlite://")
    return store.get(uid)


class Job:
    def run(self):
        return None


class ReportJob(Job):
    def run(self):
        return load_user(0)


def run_job(job: Job):
    return job.run()  # bound to Job.run; ReportJob.run is what may actually run
