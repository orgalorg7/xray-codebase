namespace Acme.Models
{
    public abstract class Entity
    {
        protected void Validate() { }
        public abstract string Key();
    }
    public interface IKeyed { string Key(); }
}
